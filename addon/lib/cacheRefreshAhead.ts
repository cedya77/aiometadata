// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export {};

const redis: any = require('./redisClient');
const consola: any = require('consola');
const { getSetting }: any = require('./settingsService');
const { runWithSourceRefetch }: any = require('./cacheSourceRefetch');

const logger = consola.withTag('Refresh-Ahead');

const LOCK_SECONDS = 300;
const REBUILD_TIMEOUT_MS = LOCK_SECONDS * 1000;
const DEFAULT_FRACTION = 0.1;
const MIN_FRACTION = 0.01;
const MAX_FRACTION = 0.5;
const DEFAULT_MAX_CONCURRENT = 3;

const inFlight = new Set<string>();
let activeCount = 0;

const stats = {
  started: 0,
  succeeded: 0,
  declined: 0,
  skipped: 0,
  skippedInflight: 0,
  skippedCapped: 0,
  skippedLocked: 0,
  failed: 0,
};

function readSetting(key: string): string {
  try {
    return getSetting(key);
  } catch {
    return '';
  }
}

function isRefreshAheadEnabled(): boolean {
  return readSetting('CATALOG_REFRESH_AHEAD_ENABLED') !== 'false';
}

function fraction(): number {
  const parsed = Number.parseFloat(readSetting('CATALOG_REFRESH_AHEAD_FRACTION'));
  if (!Number.isFinite(parsed) || parsed < MIN_FRACTION || parsed > MAX_FRACTION) return DEFAULT_FRACTION;
  return parsed;
}

function maxConcurrent(): number {
  const parsed = Number.parseInt(readSetting('CATALOG_REFRESH_AHEAD_MAX_CONCURRENT'), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENT;
  return parsed;
}

function isDueForRefresh(pttlMs: number, ttlSeconds: number): boolean {
  if (!Number.isFinite(pttlMs) || pttlMs <= 0) return false;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;
  return pttlMs < ttlSeconds * 1000 * fraction();
}

function countItems(value: any): number | null {
  if (value && Array.isArray(value.metas)) return value.metas.length;
  if (Array.isArray(value)) return value.length;
  if (value && value.meta && typeof value.meta === 'object') {
    return Object.keys(value.meta).length > 0 ? 1 : 0;
  }
  return null;
}

function mayReplaceOnRefresh(existing: any, incoming: any): boolean {
  const had = countItems(existing);
  const has = countItems(incoming);
  if (had === null || has === null) return true;
  return !(had > 0 && has === 0);
}

function refreshLockKey(versionedKey: string): string {
  return `refresh-lock:${versionedKey}`;
}

function declineBackoffSeconds(pttlMs: number): number {
  if (!Number.isFinite(pttlMs) || pttlMs <= 0) return LOCK_SECONDS;
  return Math.max(LOCK_SECONDS, Math.ceil(pttlMs / 1000));
}

function withRebuildTimeout(rebuild: () => Promise<boolean>): Promise<boolean> {
  let timer: any = null;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`rebuild exceeded ${LOCK_SECONDS}s`)), REBUILD_TIMEOUT_MS);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  return Promise.race([runWithSourceRefetch(rebuild), expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runRefreshAhead(versionedKey: string, rebuild: () => Promise<boolean>, pttlMs: number = 0): Promise<void> {
  if (inFlight.has(versionedKey)) {
    stats.skipped += 1;
    stats.skippedInflight += 1;
    return;
  }
  if (activeCount >= maxConcurrent()) {
    stats.skipped += 1;
    stats.skippedCapped += 1;
    return;
  }

  inFlight.add(versionedKey);
  activeCount += 1;

  const lockKey = refreshLockKey(versionedKey);

  try {
    const acquired = await redis.set(lockKey, '1', 'EX', LOCK_SECONDS, 'NX');
    if (!acquired) {
      stats.skipped += 1;
      stats.skippedLocked += 1;
      return;
    }

    stats.started += 1;
    const wrote = await withRebuildTimeout(rebuild);
    if (wrote) {
      stats.succeeded += 1;
      logger.debug(`Rebuilt ${versionedKey} off the request path`);
    } else {
      stats.skipped += 1;
      stats.declined += 1;
      await Promise.resolve(redis.expire(lockKey, declineBackoffSeconds(pttlMs))).catch(() => {});
    }
  } catch (error: any) {
    stats.failed += 1;
    logger.warn(`Refresh failed for ${versionedKey}: ${error?.message}`);
  } finally {
    inFlight.delete(versionedKey);
    activeCount -= 1;
  }
}

function getRefreshAheadStats(): any {
  return { ...stats };
}

function resetRefreshAheadStats(): void {
  for (const field of Object.keys(stats)) {
    (stats as any)[field] = 0;
  }
}

function __resetForTests(): void {
  inFlight.clear();
  activeCount = 0;
}

module.exports = {
  isRefreshAheadEnabled,
  isDueForRefresh,
  mayReplaceOnRefresh,
  runRefreshAhead,
  getRefreshAheadStats,
  resetRefreshAheadStats,
  __resetForTests,
};
