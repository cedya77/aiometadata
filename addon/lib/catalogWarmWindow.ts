// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export {};

const redis: any = require('./redisClient');
const { getSetting }: any = require('./settingsService');

/**
 * The warm schedule anchors on the moment a run starts, so a run slowed by rate
 * limits writes its later catalogs well after that anchor. Left alone those
 * entries outlive the next run, which then reads them as hits and never resets
 * their TTL, so they lapse minutes into the new cycle and stay cold until the
 * run after that.
 *
 * Every catalog write for a warmed UUID is therefore held to expire shortly
 * before the next run is due. The clamp only ever shortens: a catalog set to
 * refresh faster than the warm interval keeps its own TTL.
 *
 * A run in progress publishes its own anchor: the completed-run stamp is only
 * written once the UUID finishes, so mid-run it still reads the previous run,
 * which is always at least one interval behind.
 */

const MEMO_MS = 30_000;
const MIN_TTL_SECONDS = 30;
const RUN_ANCHOR_PREFIX = 'catalog-warmup:run-anchor:';

let warmedUuids: { value: Set<string>; readAt: number } | null = null;
const lastRunMemo = new Map<string, { value: number | null; readAt: number }>();

function readSetting(key: string): string {
  try {
    return getSetting(key) || '';
  } catch {
    return '';
  }
}

function leadSeconds(): number {
  const parsed = Number.parseInt(readSetting('CATALOG_WARMUP_TTL_LEAD_SECONDS'), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 60;
  return parsed;
}

function intervalMs(): number {
  const parsed = Number.parseFloat(readSetting('CATALOG_WARMUP_INTERVAL_HOURS'));
  const hours = Number.isFinite(parsed) && parsed >= 12 ? parsed : 24;
  return hours * 60 * 60 * 1000;
}

function isComprehensiveWarming(): boolean {
  return (readSetting('CACHE_WARMUP_MODE') || 'essential') === 'comprehensive';
}

function warmedUuidSet(): Set<string> {
  const now = Date.now();
  if (warmedUuids && now - warmedUuids.readAt < MEMO_MS) return warmedUuids.value;

  const raw = readSetting('CACHE_WARMUP_UUIDS') || readSetting('CACHE_WARMUP_UUID');
  const value = new Set(
    raw.split(',').map((uuid: string) => uuid.trim()).filter(Boolean).slice(0, 5)
  );
  warmedUuids = { value, readAt: now };
  return value;
}

function toTimestamp(raw: any): number | null {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function scheduleAnchorAt(userUUID: string): Promise<number | null> {
  const now = Date.now();
  const memo = lastRunMemo.get(userUUID);
  if (memo && now - memo.readAt < MEMO_MS) return memo.value;

  let value: number | null = null;
  try {
    const [running, completed] = await Promise.all([
      redis.get(`${RUN_ANCHOR_PREFIX}${userUUID}`),
      redis.get(`catalog-warmup:last-run:${userUUID}`),
    ]);
    value = toTimestamp(running) ?? toTimestamp(completed);
  } catch {
    value = null;
  }

  lastRunMemo.set(userUUID, { value, readAt: now });
  return value;
}

/**
 * The memo is written alongside the key so the first catalogs of a run are not
 * still holding a reading from just before the anchor appeared.
 */
async function markWarmRunStarted(userUUID: string, startedAt: number): Promise<void> {
  if (!userUUID || !Number.isFinite(startedAt)) return;
  try {
    const ttlSeconds = Math.max(MIN_TTL_SECONDS, Math.ceil(intervalMs() / 1000));
    await redis.set(`${RUN_ANCHOR_PREFIX}${userUUID}`, String(startedAt), 'EX', ttlSeconds);
  } catch {
    // A missing anchor only costs this run its warm window, so it must not stop it.
  }
  lastRunMemo.set(userUUID, { value: startedAt, readAt: Date.now() });
}

async function markWarmRunFinished(userUUID: string): Promise<void> {
  if (!userUUID) return;
  try {
    await redis.del(`${RUN_ANCHOR_PREFIX}${userUUID}`);
  } catch {
    // Falls back to the anchor's own expiry.
  }
  lastRunMemo.delete(userUUID);
}

async function clampTtlToWarmWindow(userUUID: string, ttl: number): Promise<number> {
  if (!Number.isFinite(ttl) || ttl <= 0) return ttl;
  if (!userUUID || !isComprehensiveWarming()) return ttl;
  if (!warmedUuidSet().has(userUUID)) return ttl;

  const anchor = await scheduleAnchorAt(userUUID);
  if (anchor === null) return ttl;

  const msUntilNextRun = anchor + intervalMs() - Date.now();
  // A run that is already due refetches everything it touches, so a short entry
  // here is enough to keep the next request from reading a stale one first.
  const budget = Math.floor(msUntilNextRun / 1000) - leadSeconds();
  if (budget >= ttl) return ttl;

  return Math.max(MIN_TTL_SECONDS, budget);
}

module.exports = {
  clampTtlToWarmWindow,
  markWarmRunStarted,
  markWarmRunFinished,
};
