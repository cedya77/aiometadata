// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
const store: any = require('./store');
const { classifyMetaStability, deriveStabilityStamp }: any = require('./stability');
const { isColdStoreEnabled, isColdStoreStrict }: any = require('./config');
const { classifyMetaCompleteness }: any = require('./completeness');
const { decodeCachePayload }: any = require('../cacheCodec');

const logger = consola.withTag('ColdStore');

export function isEnabled(): boolean { return isColdStoreEnabled(); }
export function init(): void { store.init(); }
export function classify(meta: any) { return classifyMetaStability(meta); }

/**
 * Rows are keyed by a component's per-component key (`meta-basic:<hash>:<id>`),
 * which the hot tier no longer uses now that a title lives in one hash; it is
 * the stable name the cold store knows a component by. Keys may still arrive
 * with an invalidation prefix (`e12:…`, or `v2.8.0:…` before the epoch
 * existed), which is stripped: the cold store tracks payload shape in its own
 * `epoch` column, so it survives a hot-tier prefix change.
 */
const { stripCachePrefix }: any = require('../cacheEpoch');

export function writeThrough(
  meta: any,
  componentsToCache: Array<{ cacheKey: string; componentData: any }>,
): { stable: boolean; tier: 'frozen' | 'stable' | 'partial' | null; enqueued: number; skipped?: boolean } {
  const cls = classifyMetaStability(meta);
  if (!cls.stable || !cls.tier) return { stable: false, tier: null, enqueued: 0 };

  const comp = isColdStoreStrict()
    ? classifyMetaCompleteness(meta)
    : { verdict: 'complete' as const, reasons: [] as string[] };

  if (comp.verdict === 'skip') {
    // Warn, not debug: nothing is written, so stats() cannot surface this.
    logger.warn(`Not storing ${meta?.id}: ${comp.reasons.join(', ')}`);
    return { stable: false, tier: null, enqueued: 0, skipped: true };
  }

  const tier: 'frozen' | 'stable' | 'partial' = comp.verdict === 'partial' ? 'partial' : cls.tier;
  if (tier === 'partial') {
    logger.debug(`Demoting ${meta?.id} to partial: ${comp.reasons.join(', ')}`);
  }

  const rows = componentsToCache.map(({ cacheKey, componentData }) => {
    const parts = cacheKey.split(':');
    return {
      k: cacheKey,
      metaId: parts.slice(2).join(':') || meta.id,
      component: parts[0],
      tier,
      componentData,
    };
  });
  store.put(rows);
  return { stable: true, tier, enqueued: rows.length };
}

export async function readThrough(missingKeys: string[]): Promise<Map<string, { buffer: Buffer; data: any }>> {
  const out = new Map<string, { buffer: Buffer; data: any }>();
  if (missingKeys.length === 0) return out;

  // Look up bare keys, but answer under the caller's versioned keys so the Redis
  // re-warm writes back to the key the hot tier is actually being asked for.
  const callerKeys = new Map<string, string[]>();
  for (const key of missingKeys) {
    const bare = stripCachePrefix(key);
    const existing = callerKeys.get(bare);
    if (existing) existing.push(key);
    else callerKeys.set(bare, [key]);
  }

  const encoded: Map<string, Buffer> = store.getEncoded([...callerKeys.keys()]);
  for (const [bare, buffer] of encoded) {
    let data: any;
    try {
      data = await decodeCachePayload(buffer);
    } catch (error: any) {
      logger.warn(`Discarding unreadable cold-store row ${bare}: ${error?.message}`);
      store.invalidateKey(bare);
      continue;
    }
    for (const original of callerKeys.get(bare) || []) {
      out.set(original, { buffer, data });
    }
  }
  return out;
}

export const invalidate = store.invalidate;
export const invalidateKey = store.invalidateKey;
export const invalidateByToken = store.invalidateByToken;
export const countByToken = store.countByToken;
export const countByMetaId = store.countByMetaId;
export const purge = store.purge;
export const sweep = store.sweep;
export const stats = store.stats;
export const getEncoded = store.getEncoded;
export const put = store.put;
export const flushNow = store.flushNow;
export const close = store.close;

module.exports = {
  isEnabled, init, classify, classifyMetaCompleteness, deriveStabilityStamp, writeThrough, readThrough,
  invalidate: store.invalidate, invalidateKey: store.invalidateKey,
  invalidateByToken: store.invalidateByToken,
  countByToken: store.countByToken, countByMetaId: store.countByMetaId,
  purge: store.purge, sweep: store.sweep, stats: store.stats,
  getEncoded: store.getEncoded, put: store.put, flushNow: store.flushNow, close: store.close,
};
