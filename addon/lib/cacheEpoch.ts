// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE

export const DEFAULT_CACHE_EPOCH = 3;

export function getCacheEpoch(): number {
  const raw = (process.env.CACHE_EPOCH || '').trim();
  if (!raw) return DEFAULT_CACHE_EPOCH;
  if (!/^\d+$/.test(raw)) return DEFAULT_CACHE_EPOCH;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CACHE_EPOCH;
}

/** `e12:catalog:<hash>:<id>` — the prefix every derived cache key now carries. */
const EPOCH_KEY = /^e(\d+):/;
const GLOBAL_EPOCH_KEY = /^global:e(\d+):/;

/**
 * Keys written before the epoch existed, prefixed with the addon version
 * (`v2.8.0:…` and `global:2.8.0:…`). Always superseded — the shape they were
 * written under is unknowable.
 */
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?`;
const LEGACY_KEY = new RegExp(`^v${SEMVER}:`);
const LEGACY_GLOBAL_KEY = new RegExp(`^global:${SEMVER}:`);

/** SCAN patterns covering every prefix the cleanup must consider. */
export const CACHE_KEY_SCAN_PATTERNS = ['e*', 'v*', 'global:*'];

export function withEpoch(key: string): string {
  return `e${getCacheEpoch()}:${key}`;
}

export function withGlobalEpoch(key: string): string {
  return `global:e${getCacheEpoch()}:${key}`;
}

export function stripCachePrefix(key: string): string {
  return key.replace(EPOCH_KEY, '').replace(LEGACY_KEY, '');
}

export function isSupersededCacheKey(key: string, currentEpoch: number = getCacheEpoch()): boolean {
  if (LEGACY_KEY.test(key) || LEGACY_GLOBAL_KEY.test(key)) return true;
  const match = GLOBAL_EPOCH_KEY.exec(key) || EPOCH_KEY.exec(key);
  if (!match) return false;
  return Number.parseInt(match[1], 10) < currentEpoch;
}

module.exports = {
  DEFAULT_CACHE_EPOCH,
  getCacheEpoch,
  CACHE_KEY_SCAN_PATTERNS,
  withEpoch,
  withGlobalEpoch,
  stripCachePrefix,
  isSupersededCacheKey,
};
