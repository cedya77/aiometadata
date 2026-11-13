// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import * as path from 'node:path';

const SIZE_UNITS: Record<string, number> = {
  b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4,
};
const DURATION_UNITS: Record<string, number> = {
  s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600,
  d: 86400, w: 604800, y: 31536000,
};

function parseUnit(value: string | undefined, units: Record<string, number>): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value || '');
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit ? units[unit] : 1;
  if (!multiplier || !Number.isFinite(amount)) return null;
  return Math.floor(amount * multiplier);
}

export function parseSize(value?: string): number | null { return parseUnit(value, SIZE_UNITS); }
export function parseDuration(value?: string): number | null { return parseUnit(value, DURATION_UNITS); }
export function isTruthy(value?: string): boolean { return /^(1|true|yes|on)$/i.test(value || ''); }

export function isColdStoreEnabled(): boolean { return isTruthy(process.env.META_COLD_STORE_ENABLED); }

export function isColdStoreCompressionEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test((process.env.META_COLD_STORE_COMPRESSION || '').trim());
}

export function getColdStorePath(): string {
  const configured = (process.env.META_COLD_STORE_PATH || '').trim();
  return configured || path.join(process.cwd(), 'addon', 'data', 'metacache.sqlite');
}

export function getColdStoreMaxBytes(): number {
  return parseSize(process.env.META_COLD_STORE_MAX_BYTES) ?? parseSize('2gb')!;
}

export type ColdTier = 'frozen' | 'stable' | 'partial';

/** Default-on, matching the compression flag's "true unless explicitly falsy" idiom. */
export function isColdStoreStrict(): boolean {
  return !/^(0|false|no|off)$/i.test((process.env.META_COLD_STORE_STRICT || '').trim());
}

export function getColdTtlSeconds(tier: ColdTier): number {
  if (tier === 'frozen') return parseDuration(process.env.COLD_TTL_FROZEN) ?? parseDuration('180d')!;
  // Longer than META_TTL (7d) on purpose, so the row outlives its Redis counterpart.
  if (tier === 'partial') return parseDuration(process.env.COLD_TTL_PARTIAL) ?? parseDuration('14d')!;
  return parseDuration(process.env.COLD_TTL_STABLE) ?? parseDuration('60d')!;
}

export function getSettleSeconds(kind: 'movie' | 'series'): number {
  return kind === 'movie'
    ? parseDuration(process.env.SETTLE_MOVIE) ?? parseDuration('180d')!
    : parseDuration(process.env.SETTLE_SERIES) ?? parseDuration('90d')!;
}

export function getFrozenAgeSeconds(): number {
  return parseDuration(process.env.FROZEN_AGE) ?? parseDuration('2y')!;
}

export function getInactiveDays(): number {
  const parsed = parseInt(process.env.COLD_STORE_INACTIVE_DAYS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export function getColdStoreStatsTtlSeconds(): number {
  const parsed = parseDuration(process.env.COLD_STORE_STATS_TTL);
  return parsed !== null && parsed >= 0 ? parsed : 30;
}

module.exports = {
  parseSize, parseDuration, isTruthy, isColdStoreEnabled, isColdStoreCompressionEnabled,
  isColdStoreStrict,
  getColdStorePath, getColdStoreMaxBytes, getColdTtlSeconds, getSettleSeconds,
  getFrozenAgeSeconds, getInactiveDays, getColdStoreStatsTtlSeconds,
};
