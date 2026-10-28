import BetterSqlite3 from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import consola from 'consola';
const { encodeCachePayload }: any = require('../cacheCodec');
const { getCacheEpoch }: any = require('../cacheEpoch');
import {
  getColdStorePath,
  getColdStoreMaxBytes,
  getColdTtlSeconds,
  getInactiveDays,
  getColdStoreStatsTtlSeconds,
  isColdStoreCompressionEnabled,
} from './config';

const logger = consola.withTag('ColdStore');

export type PutRow = { k: string; metaId: string; component: string; tier: 'frozen' | 'stable' | 'partial'; componentData: any };

let db: BetterSqlite3.Database | null = null;
const writeQueue: PutRow[] = [];
let flushScheduled = false;
let bytesSinceEvictCheck = 0;
const EVICT_CHECK_MAX_BYTES = 64 * 1024 * 1024;

// Resolved once per open, not per query: the purge below is keyed to it, so a
// mid-run env change must not desync reads from what init() already dropped.
let currentEpoch = 0;

// Compiled once per open database; reads are keyed by how many keys they bind.
type HotStatements = {
  selectByCount: Map<number, BetterSqlite3.Statement>;
  touchMany: (now: number, ks: string[]) => void;
  upsertMany: (items: any[]) => void;
};
let hot: HotStatements | null = null;

function hotStatements(database: BetterSqlite3.Database): HotStatements {
  if (hot) return hot;
  const touch = database.prepare(`UPDATE meta_components SET last_access = ? WHERE k = ?`);
  // `epoch` is part of the update set: a row left behind by a newer release is
  // reclaimed by whichever epoch last wrote it, so its payload and its label agree.
  const upsert = database.prepare(`
    INSERT INTO meta_components (k, meta_id, component, payload, tier, created_at, expires_at, last_access, epoch)
    VALUES (@k, @meta_id, @component, @payload, @tier, @created_at, @expires_at, @last_access, @epoch)
    ON CONFLICT(k) DO UPDATE SET
      payload = excluded.payload, tier = excluded.tier,
      expires_at = excluded.expires_at, last_access = excluded.last_access,
      epoch = excluded.epoch
  `);
  hot = {
    selectByCount: new Map(),
    touchMany: database.transaction((now: number, ks: string[]) => { for (const k of ks) touch.run(now, k); }),
    upsertMany: database.transaction((items: any[]) => { for (const it of items) upsert.run(it); }),
  };
  return hot;
}

function selectStatement(database: BetterSqlite3.Database, count: number): BetterSqlite3.Statement {
  const statements = hotStatements(database).selectByCount;
  let statement = statements.get(count);
  if (!statement) {
    const placeholders = Array.from({ length: count }, () => '?').join(',');
    statement = database.prepare(
      `SELECT k, payload, expires_at FROM meta_components WHERE k IN (${placeholders}) AND epoch = ?`
    );
    statements.set(count, statement);
  }
  return statement;
}

/**
 * Rows predating the epoch column carry the addon version inside `k` and have no
 * recorded payload shape. Epoch 0 marks them, and the purge in init() drops them.
 */
function ensureEpochColumn(database: BetterSqlite3.Database): void {
  const columns = database.prepare(`PRAGMA table_info(meta_components)`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'epoch')) return;
  database.exec(`ALTER TABLE meta_components ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0`);
  logger.info('Migrated cold store schema: added epoch column');
}

export function init(): void {
  if (db) return;
  const file = getColdStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new BetterSqlite3(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_components (
      k          TEXT PRIMARY KEY,
      meta_id    TEXT NOT NULL,
      component  TEXT NOT NULL,
      payload    BLOB NOT NULL,
      tier       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_access INTEGER NOT NULL,
      epoch      INTEGER NOT NULL DEFAULT 0
    );
  `);
  ensureEpochColumn(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mc_meta_id ON meta_components(meta_id);
    CREATE INDEX IF NOT EXISTS idx_mc_expires ON meta_components(expires_at);
    CREATE INDEX IF NOT EXISTS idx_mc_last_access ON meta_components(last_access);
    DROP INDEX IF EXISTS idx_mc_epoch;
    DROP INDEX IF EXISTS idx_mc_stats;
  `);

  currentEpoch = getCacheEpoch();
  // Only *older* epochs are dropped. Rows from a newer epoch are unreadable here
  // but are left alone, so rolling a release back and forward again is free.
  const dropped = db.prepare(`DELETE FROM meta_components WHERE epoch < ?`).run(currentEpoch).changes;
  if (dropped > 0) logger.info(`Dropped ${dropped} rows from epochs older than ${currentEpoch}`);
  logger.info(`Meta cold store ready at ${file} (epoch ${currentEpoch})`);
}

export function getEncoded(keys: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!db || keys.length === 0) return out;
  const now = Date.now();
  const rows = selectStatement(db, keys.length)
    .all(...keys, currentEpoch) as Array<{ k: string; payload: Buffer; expires_at: number }>;

  const hits: string[] = [];
  for (const row of rows) {
    if (row.expires_at <= now) continue;
    out.set(row.k, row.payload);
    hits.push(row.k);
  }
  if (hits.length) hotStatements(db).touchMany(now, hits);
  return out;
}

export function put(rows: PutRow[]): void {
  if (!db || rows.length === 0) return;
  for (const r of rows) writeQueue.push(r);
  if (flushScheduled) return;
  flushScheduled = true;
  setImmediate(() => { flushScheduled = false; flushNow().catch((e: any) => logger.warn(`flush failed: ${e?.message}`)); });
}

export async function flushNow(): Promise<void> {
  if (!db || writeQueue.length === 0) return;
  const batch = writeQueue.splice(0, writeQueue.length);
  const now = Date.now();

  // Read once per flush, not per row, so a whole batch encodes consistently.
  const compressionEnabled = isColdStoreCompressionEnabled();

  const prepared: Array<{ k: string; meta_id: string; component: string; payload: Buffer; tier: string; created_at: number; expires_at: number; last_access: number; epoch: number }> = [];
  for (const r of batch) {
    const encoded = await encodeCachePayload(r.componentData, { compressionEnabled });
    const payload = Buffer.isBuffer(encoded) ? encoded : Buffer.from(String(encoded), 'utf8');
    prepared.push({
      k: r.k, meta_id: r.metaId, component: r.component, payload, tier: r.tier,
      created_at: now, expires_at: now + getColdTtlSeconds(r.tier) * 1000, last_access: now,
      epoch: currentEpoch,
    });
  }

  hotStatements(db).upsertMany(prepared);

  for (const it of prepared) bytesSinceEvictCheck += it.payload.length;
  if (bytesSinceEvictCheck >= Math.min(EVICT_CHECK_MAX_BYTES, Math.floor(getColdStoreMaxBytes() / 16))) {
    bytesSinceEvictCheck = 0;
    evictIfNeeded();
  }
}

function totalBytes(): number {
  if (!db) return 0;
  return (db.prepare(`SELECT COALESCE(SUM(LENGTH(payload)), 0) AS b FROM meta_components`).get() as { b: number }).b;
}

/**
 * Evicts whole titles. A title's rows are read and touched together, so the
 * titles owning the least recently used rows are the least recently used
 * titles; removing only rows would leave titles half-stored, which reads as a
 * miss and costs a full rebuild anyway.
 */
export function evictIfNeeded(batchRows: number = 500): void {
  if (!db) return;
  const max = getColdStoreMaxBytes();
  let total = totalBytes();
  if (total <= max) return;
  const target = Math.floor(max * 0.9);
  const del = db.prepare(`DELETE FROM meta_components WHERE meta_id IN (
    SELECT DISTINCT meta_id FROM (SELECT meta_id FROM meta_components ORDER BY last_access ASC LIMIT ?)
  ) RETURNING LENGTH(payload) AS n`);
  let guard = 0;
  while (total > target && guard++ < 10000) {
    const rows = del.all(batchRows) as Array<{ n: number }>;
    if (rows.length === 0) break;
    for (const r of rows) total -= r.n;
  }
  cachedStats = null;
}

function invalidated(changes: number): number {
  if (changes > 0) cachedStats = null;
  return changes;
}

export function invalidate(metaId: string): number {
  return db ? invalidated(db.prepare(`DELETE FROM meta_components WHERE meta_id = ?`).run(metaId).changes) : 0;
}

/** Drop a single row by its component key, as opposed to every row for a title. */
export function invalidateKey(k: string): number {
  return db ? invalidated(db.prepare(`DELETE FROM meta_components WHERE k = ?`).run(k).changes) : 0;
}

export function purge(): number {
  return db ? invalidated(db.prepare(`DELETE FROM meta_components`).run().changes) : 0;
}

/** Escape LIKE wildcards so an operator-supplied token matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function countByMetaId(metaId: string): number {
  if (!db || !metaId) return 0;
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM meta_components WHERE meta_id = ?`
  ).get(metaId) as { c: number };
  return row.c;
}

export function countByToken(token: string): number {
  if (!db || !token) return 0;
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM meta_components WHERE k LIKE ? ESCAPE '\\'`
  ).get(`%${escapeLike(token)}%`) as { c: number };
  return row.c;
}

export function invalidateByToken(token: string): number {
  if (!db || !token) return 0;
  return invalidated(db.prepare(
    `DELETE FROM meta_components WHERE k LIKE ? ESCAPE '\\'`
  ).run(`%${escapeLike(token)}%`).changes);
}

export function sweep(): number {
  if (!db) return 0;
  const now = Date.now();
  const inactiveCutoff = now - getInactiveDays() * 86400 * 1000;
  return invalidated(db.prepare(`DELETE FROM meta_components WHERE expires_at <= ? OR last_access < ?`).run(now, inactiveCutoff).changes);
}

export type TierStats = { tier: string; count: number; titles: number; bytes: number };
export type ColdStoreStats = {
  enabled: boolean;
  rows: number;
  titles: number;
  bytes: number;
  maxBytes: number;
  tiers: TierStats[];
  oldestCreatedAt: number | null;
  nextExpiryAt: number | null;
  expiredRows: number;
};

let cachedStats: { at: number; value: ColdStoreStats } | null = null;

export function stats(): ColdStoreStats {
  const empty: ColdStoreStats = {
    enabled: false, rows: 0, titles: 0, bytes: 0, maxBytes: getColdStoreMaxBytes(),
    tiers: [], oldestCreatedAt: null, nextExpiryAt: null, expiredRows: 0,
  };
  if (!db) return empty;

  const ttlMs = getColdStoreStatsTtlSeconds() * 1000;
  if (cachedStats && ttlMs > 0 && Date.now() - cachedStats.at < ttlMs) return cachedStats.value;

  const now = Date.now();
  const r = db.prepare(`
    SELECT COUNT(*) AS rows, COUNT(DISTINCT meta_id) AS titles,
           COALESCE(SUM(LENGTH(payload)), 0) AS bytes,
           MIN(created_at) AS oldest, MIN(expires_at) AS next_expiry,
           COALESCE(SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END), 0) AS expired
    FROM meta_components
  `).get(now) as { rows: number; titles: number; bytes: number; oldest: number | null; next_expiry: number | null; expired: number };

  const tiers = db.prepare(`
    SELECT tier, COUNT(*) AS count, COUNT(DISTINCT meta_id) AS titles,
           COALESCE(SUM(LENGTH(payload)), 0) AS bytes
    FROM meta_components GROUP BY tier ORDER BY tier
  `).all() as TierStats[];

  const value: ColdStoreStats = {
    enabled: true,
    rows: r.rows,
    titles: r.titles,
    bytes: r.bytes,
    maxBytes: getColdStoreMaxBytes(),
    tiers,
    oldestCreatedAt: r.oldest ?? null,
    nextExpiryAt: r.next_expiry ?? null,
    expiredRows: r.expired,
  };
  cachedStats = { at: Date.now(), value };
  return value;
}

export function close(): void {
  if (db) { db.close(); db = null; hot = null; }
}

module.exports = {
  init, getEncoded, put, flushNow, invalidate, invalidateKey, invalidateByToken,
  countByToken, countByMetaId, purge, sweep, stats, close, evictIfNeeded,
};
