import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import consola from 'consola';
import {
  IMAGE_CLASSES,
  formatSize,
  getCacheDir,
  getEntryExpiry,
  getEntryExpiryFrom,
  getEntryTtlDays,
  getInactiveDays,
  getMaxBytes,
  getMaxSizeRaw,
  getMemoryBudget,
  getMemorySizeRaw,
  getStreamThresholdBytes,
  hostFromKey,
  inferredTtlMsFor,
  isInferTtlEnabled,
  isNotStorable,
  resolveEntryTtlMs,
  type ImageClass,
  type UpstreamCacheMeta,
} from './config.js';
import { isNotModified, mergeRevalidated, type ConditionalValidators, type FetchOutcome } from './upstream.js';
import { walkFiles, pruneEmptyDirs } from './walk.js';
import { shapePoster } from './shape.js';
import { envInt } from '../../utils/envNumber';
import { sizedKeys } from './resize.js';

const logger = consola.withTag('PosterCache');

const MAGIC = Buffer.from('AIOM1', 'ascii');
const HEADER_OFFSET = MAGIC.length + 4;

const ACCESS_TOUCH_MS = 6 * 60 * 60 * 1000;

export interface EntryHeader {
  key: string;
  contentType: string;
  size: number;
  storedAt: number;
  bodyHash?: string;
  upstream?: UpstreamCacheMeta;
}

export interface CacheEntry {
  contentType: string;
  storedAt: number;
  expired: boolean;
  expiresAt: number;
  hash: string;
  etag: string;
  size: number;
  upstream?: UpstreamCacheMeta;
  body?: Buffer;
  openStream?: () => NodeJS.ReadableStream;
}

function revalidationHint(entry: CacheEntry | null): ConditionalValidators | undefined {
  const upstream = entry?.upstream;
  if (!upstream || (!upstream.etag && !upstream.lastModified)) return undefined;
  return { etag: upstream.etag, lastModified: upstream.lastModified };
}

function sameValidators(stored?: UpstreamCacheMeta, merged?: UpstreamCacheMeta): boolean {
  return (stored?.etag ?? '') === (merged?.etag ?? '')
    && (stored?.lastModified ?? '') === (merged?.lastModified ?? '');
}

interface IndexEntry {
  imageClass: ImageClass;
  hash: string;
  size: number;
  lastAccess: number;
  storedAt: number;
  inferredMs: number | null;
  ids?: string[];
}

interface ClassTotals {
  count: number;
  bytes: number;
}

const index = new Map<string, IndexEntry>();
const classTotals = new Map<ImageClass, ClassTotals>();
const inflight = new Map<string, Promise<FetchResult>>();


interface MemoryEntry {
  body: Buffer;
  contentType: string;
  storedAt: number;
  etag: string;
  upstream?: UpstreamCacheMeta;
}
const memory = new Map<string, MemoryEntry>();
let memoryBytes = 0;
let memoryHits = 0;

let initialized = false;
let scanning = false;

/**
 * Settles when the initial index scan has finished. Resolved up front so a
 * disabled or never-initialized cache cannot leave a waiter hanging, and the
 * scan promise is pre-caught so a failed scan resolves rather than rejects.
 */
let indexed: Promise<void> = Promise.resolve();

/** Await before trusting index-derived answers such as isCachedFresh(). */
export function whenIndexed(): Promise<void> {
  return indexed;
}
let idIndexing = false;
let idIndexBuilt = false;


const ID_PATTERNS: RegExp[] = [
  /\b(tt\d{7,10})\b/gi,
  /[?&](?:tmdb_id|tmdbid)=(\d+)/gi,
  /[?&](?:tvdb_id|tvdbid)=(\d+)/gi,
  /\btmdb[:/](\d+)/gi,
  /\btvdb[:/](\d+)/gi,
];

export function extractIdTokens(url: string): string[] {
  const found = new Set<string>();
  for (const pattern of ID_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(url)) !== null) {
      const raw = match[1];
      if (!raw) continue;
      found.add(/^tt/i.test(raw) ? raw.toLowerCase() : raw);
    }
  }
  return [...found];
}

let evicting = false;
let sweepTimer: NodeJS.Timeout | null = null;

function indexKey(imageClass: ImageClass, hash: string): string {
  return `${imageClass}/${hash}`;
}

function totalsFor(imageClass: ImageClass): ClassTotals {
  let totals = classTotals.get(imageClass);
  if (!totals) {
    totals = { count: 0, bytes: 0 };
    classTotals.set(imageClass, totals);
  }
  return totals;
}

function addToIndex(entry: IndexEntry): void {
  const key = indexKey(entry.imageClass, entry.hash);
  const existing = index.get(key);
  const totals = totalsFor(entry.imageClass);
  if (existing) {
    totals.bytes -= existing.size;
    totals.count -= 1;
  }
  index.set(key, entry);
  totals.bytes += entry.size;
  totals.count += 1;
}

function removeFromIndex(imageClass: ImageClass, hash: string): number {
  const key = indexKey(imageClass, hash);
  const existing = index.get(key);
  if (!existing) return 0;
  index.delete(key);
  const totals = totalsFor(imageClass);
  totals.bytes -= existing.size;
  totals.count -= 1;
  if (totals.bytes < 0) totals.bytes = 0;
  if (totals.count < 0) totals.count = 0;
  return existing.size;
}

export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function hashBody(body: Buffer): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}


function legacyEtag(hash: string, storedAt: number): string {
  return `${hash.slice(0, 32)}-${storedAt.toString(36)}`;
}

// --- In-memory tier ---

function memoryTake(key: string): MemoryEntry | undefined {
  const hit = memory.get(key);
  if (!hit) return undefined;
  memory.delete(key);
  memory.set(key, hit);
  memoryHits += 1;
  return hit;
}

function memoryDrop(key: string): void {
  const existing = memory.get(key);
  if (!existing) return;
  memory.delete(key);
  memoryBytes -= existing.body.length;
  if (memoryBytes < 0) memoryBytes = 0;
}

function memoryPut(
  key: string,
  body: Buffer,
  contentType: string,
  storedAt: number,
  etag: string,
  upstream?: UpstreamCacheMeta
): void {
  const budget = getMemoryBudget();
  if (budget <= 0) return;
  if (body.length > getStreamThresholdBytes()) return;
  if (body.length > budget) return;

  memoryDrop(key);
  memory.set(key, { body, contentType, storedAt, etag, upstream });
  memoryBytes += body.length;

  while (memoryBytes > budget) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memoryDrop(oldest.value);
  }
}

function memoryClear(prefix?: string): void {
  if (!prefix) {
    memory.clear();
    memoryBytes = 0;
    return;
  }
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) memoryDrop(key);
  }
}

function entryPath(imageClass: ImageClass, hash: string): string {
  return path.join(getCacheDir(), imageClass, hash.slice(0, 2), hash.slice(2, 4), hash);
}

function totalBytes(): number {
  let sum = 0;
  for (const totals of classTotals.values()) sum += totals.bytes;
  return sum;
}

function totalCount(): number {
  let sum = 0;
  for (const totals of classTotals.values()) sum += totals.count;
  return sum;
}

function encode(header: EntryHeader, body: Buffer): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(headerJson.length, 0);
  return Buffer.concat([MAGIC, lengthPrefix, headerJson, body]);
}

const HEADER_PROBE_BYTES = 8192;

function readFraming(probe: Buffer): { headerLen: number; bodyOffset: number } | null {
  if (probe.length < HEADER_OFFSET) return null;
  if (!probe.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const headerLen = probe.readUInt32BE(MAGIC.length);
  if (headerLen <= 0 || headerLen > HEADER_PROBE_BYTES * 8) return null;
  return { headerLen, bodyOffset: HEADER_OFFSET + headerLen };
}

export async function get(imageClass: ImageClass, key: string): Promise<CacheEntry | null> {
  const hash = hashKey(key);
  const file = entryPath(imageClass, hash);
  const idxKey = indexKey(imageClass, hash);

  const cached = memoryTake(idxKey);
  if (cached) {
    const inferredMs = inferredTtlMsFor(cached.upstream);
    touch(imageClass, hash, file, index.get(idxKey)?.size ?? cached.body.length, {
      storedAt: cached.storedAt,
      inferredMs,
    });
    const expiresAt = getEntryExpiryFrom(key, cached.storedAt, inferredMs);
    return {
      contentType: cached.contentType,
      storedAt: cached.storedAt,
      expired: Date.now() > expiresAt,
      expiresAt,
      hash,
      etag: cached.etag,
      size: cached.body.length,
      upstream: cached.upstream,
      body: cached.body,
    };
  }

  const known = index.get(idxKey);
  if (!known || known.size <= getStreamThresholdBytes()) {
    return readBuffered(imageClass, key, hash, file);
  }

  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      logger.debug(`open failed for ${imageClass}/${hash}: ${error?.message}`);
    }
    return null;
  }

  try {
    const stat = await handle.stat();
    const probeLength = Math.min(HEADER_PROBE_BYTES, stat.size);
    const probe = Buffer.alloc(probeLength);
    await handle.read(probe, 0, probeLength, 0);

    const framing = readFraming(probe);
    if (!framing) {
      logger.warn(`Discarding corrupt cache entry ${imageClass}/${hash}`);
      await handle.close();
      await remove(imageClass, hash);
      return null;
    }

    let headerJson: Buffer;
    if (framing.bodyOffset <= probeLength) {
      headerJson = probe.subarray(HEADER_OFFSET, framing.bodyOffset);
    } else {
      headerJson = Buffer.alloc(framing.headerLen);
      await handle.read(headerJson, 0, framing.headerLen, HEADER_OFFSET);
    }

    let header: EntryHeader;
    try {
      header = JSON.parse(headerJson.toString('utf8'));
    } catch {
      logger.warn(`Discarding cache entry with unreadable header ${imageClass}/${hash}`);
      await handle.close();
      await remove(imageClass, hash);
      return null;
    }

    const bodySize = stat.size - framing.bodyOffset;
    const inferredMs = inferredTtlMsFor(header.upstream);
    touch(imageClass, hash, file, stat.size, { storedAt: header.storedAt, inferredMs });

    const expiresAt = getEntryExpiryFrom(key, header.storedAt, inferredMs);
    const meta = {
      contentType: header.contentType,
      storedAt: header.storedAt,
      expired: Date.now() > expiresAt,
      expiresAt,
      hash,
      etag: header.bodyHash || legacyEtag(hash, header.storedAt),
      size: bodySize,
      upstream: header.upstream,
    };

    if (bodySize > getStreamThresholdBytes()) {
      await handle.close();
      return {
        ...meta,
        openStream: () => fs.createReadStream(file, { start: framing.bodyOffset }),
      };
    }

    const body = Buffer.alloc(bodySize);
    if (bodySize > 0) {
      await handle.read(body, 0, bodySize, framing.bodyOffset);
    }
    await handle.close();
    return { ...meta, body };
  } catch (error: any) {
    await handle.close().catch(() => { /* already closing */ });
    logger.debug(`read failed for ${imageClass}/${hash}: ${error?.message}`);
    return null;
  }
}

async function readBuffered(
  imageClass: ImageClass,
  key: string,
  hash: string,
  file: string
): Promise<CacheEntry | null> {
  let raw: Buffer;
  try {
    raw = await fsp.readFile(file);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      logger.debug(`read failed for ${imageClass}/${hash}: ${error?.message}`);
    }
    return null;
  }

  const framing = readFraming(raw);
  if (!framing || framing.bodyOffset > raw.length) {
    logger.warn(`Discarding corrupt cache entry ${imageClass}/${hash}`);
    await remove(imageClass, hash);
    return null;
  }

  let header: EntryHeader;
  try {
    header = JSON.parse(raw.subarray(HEADER_OFFSET, framing.bodyOffset).toString('utf8'));
  } catch {
    logger.warn(`Discarding cache entry with unreadable header ${imageClass}/${hash}`);
    await remove(imageClass, hash);
    return null;
  }

  const inferredMs = inferredTtlMsFor(header.upstream);
  touch(imageClass, hash, file, raw.length, { storedAt: header.storedAt, inferredMs });
  const body = raw.subarray(framing.bodyOffset);
  const etag = header.bodyHash || hashBody(body);
  memoryPut(indexKey(imageClass, hash), body, header.contentType, header.storedAt, etag, header.upstream);

  const expiresAt = getEntryExpiryFrom(key, header.storedAt, inferredMs);
  return {
    contentType: header.contentType,
    storedAt: header.storedAt,
    expired: Date.now() > expiresAt,
    expiresAt,
    hash,
    etag,
    size: body.length,
    upstream: header.upstream,
    body,
  };
}

interface StoredFacts {
  storedAt: number;
  inferredMs: number | null;
  ids?: string[];
}

function touch(
  imageClass: ImageClass,
  hash: string,
  file: string,
  size: number,
  stored?: StoredFacts
): void {
  const now = Date.now();
  const existing = index.get(indexKey(imageClass, hash));
  if (existing) {
    if (stored) {
      existing.storedAt = stored.storedAt;
      existing.inferredMs = stored.inferredMs;
    }
    if (now - existing.lastAccess < ACCESS_TOUCH_MS) {
      existing.lastAccess = now;
      return;
    }
    existing.lastAccess = now;
  } else {
    addToIndex({
      imageClass,
      hash,
      size,
      lastAccess: now,
      storedAt: stored?.storedAt ?? now,
      inferredMs: stored?.inferredMs ?? null,
    });
  }
  const storedAt = stored?.storedAt ?? existing?.storedAt ?? now;
  fsp.utimes(file, now / 1000, storedAt / 1000).catch(() => { /* best effort */ });
}

export async function put(
  imageClass: ImageClass,
  key: string,
  body: Buffer,
  contentType: string,
  upstream?: UpstreamCacheMeta
): Promise<string> {
  const hash = hashKey(key);
  const file = entryPath(imageClass, hash);
  const bodyHash = hashBody(body);
  const header: EntryHeader = {
    key,
    contentType: contentType || 'image/jpeg',
    size: body.length,
    storedAt: Date.now(),
    bodyHash,
  };
  if (upstream && Object.keys(upstream).length > 0) header.upstream = upstream;

  const payload = encode(header, body);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, payload);
    await fsp.rename(tmp, file);
  } catch (error: any) {
    logger.warn(`Failed to store ${imageClass} entry: ${error?.message}`);
    await fsp.unlink(tmp).catch(() => { /* nothing to clean up */ });
    // The bytes are still valid to serve even though they were not persisted.
    return bodyHash;
  }

  addToIndex({
    imageClass,
    hash,
    size: payload.length,
    lastAccess: Date.now(),
    storedAt: header.storedAt,
    inferredMs: inferredTtlMsFor(header.upstream),
    ids: extractIdTokens(key),
  });
  memoryPut(indexKey(imageClass, hash), body, header.contentType, header.storedAt, bodyHash, header.upstream);
  scheduleEviction();
  return bodyHash;
}

async function readStoredHeader(
  imageClass: ImageClass,
  hash: string,
  file: string
): Promise<{ header: EntryHeader; framing: { headerLen: number; bodyOffset: number }; fileSize: number } | null> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch (error: any) {
    logger.debug(`Cannot refresh ${imageClass}/${hash}: ${error?.message}`);
    return null;
  }

  try {
    const fileSize = (await handle.stat()).size;
    const probeLength = Math.min(HEADER_PROBE_BYTES, fileSize);
    const probe = Buffer.alloc(probeLength);
    await handle.read(probe, 0, probeLength, 0);

    const framing = readFraming(probe);
    if (!framing || framing.bodyOffset > fileSize) return null;

    let headerJson: Buffer;
    if (framing.bodyOffset <= probeLength) {
      headerJson = probe.subarray(HEADER_OFFSET, framing.bodyOffset);
    } else {
      headerJson = Buffer.alloc(framing.headerLen);
      await handle.read(headerJson, 0, framing.headerLen, HEADER_OFFSET);
    }
    return { header: JSON.parse(headerJson.toString('utf8')), framing, fileSize };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => { /* already closing */ });
  }
}

async function rewriteHeaderStreaming(
  imageClass: ImageClass,
  hash: string,
  file: string,
  header: EntryHeader,
  oldBodyOffset: number,
  inferredMs: number | null
): Promise<{ bodySize: number; bodyOffset: number } | null> {
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(HEADER_OFFSET);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(headerJson.length, MAGIC.length);

  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let bodySize = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      const body = fs.createReadStream(file, { start: oldBodyOffset });
      out.on('error', reject);
      body.on('error', reject);
      out.write(prefix);
      out.write(headerJson);
      body.on('data', (chunk) => { bodySize += chunk.length; });
      body.on('end', () => out.end(resolve));
      body.pipe(out, { end: false });
    });
    await fsp.rename(tmp, file);
  } catch (error: any) {
    logger.warn(`Failed to refresh ${imageClass} entry: ${error?.message}`);
    await fsp.unlink(tmp).catch(() => { /* nothing to clean up */ });
    return null;
  }

  const bodyOffset = HEADER_OFFSET + headerJson.length;
  addToIndex({
    imageClass,
    hash,
    size: bodyOffset + bodySize,
    lastAccess: Date.now(),
    storedAt: header.storedAt,
    inferredMs,
  });
  memoryDrop(indexKey(imageClass, hash));
  return { bodySize, bodyOffset };
}

async function refreshStoredEntry(
  imageClass: ImageClass,
  key: string,
  upstream: UpstreamCacheMeta
): Promise<CacheEntry | null> {
  const hash = hashKey(key);
  const file = entryPath(imageClass, hash);

  const existing = await readStoredHeader(imageClass, hash, file);
  if (!existing) return null;
  const { header, framing, fileSize } = existing;

  header.storedAt = Date.now();
  if (Object.keys(upstream).length > 0) header.upstream = upstream;
  else delete header.upstream;
  const inferredMs = inferredTtlMsFor(header.upstream);

  if (fileSize - framing.bodyOffset > getStreamThresholdBytes()) {
    const refreshed = await rewriteHeaderStreaming(imageClass, hash, file, header, framing.bodyOffset, inferredMs);
    if (!refreshed) return null;
    return {
      contentType: header.contentType,
      storedAt: header.storedAt,
      expired: false,
      expiresAt: getEntryExpiryFrom(key, header.storedAt, inferredMs),
      hash,
      etag: header.bodyHash || legacyEtag(hash, header.storedAt),
      size: refreshed.bodySize,
      upstream: header.upstream,
      openStream: () => fs.createReadStream(file, { start: refreshed.bodyOffset }),
    };
  }

  let raw: Buffer;
  try {
    raw = await fsp.readFile(file);
  } catch (error: any) {
    logger.debug(`Cannot refresh ${imageClass}/${hash}: ${error?.message}`);
    return null;
  }
  const body = raw.subarray(framing.bodyOffset);

  const payload = encode(header, body);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(tmp, payload);
    await fsp.rename(tmp, file);
  } catch (error: any) {
    logger.warn(`Failed to refresh ${imageClass} entry: ${error?.message}`);
    await fsp.unlink(tmp).catch(() => { /* nothing to clean up */ });
    return null;
  }

  const etag = header.bodyHash || hashBody(body);
  addToIndex({
    imageClass,
    hash,
    size: payload.length,
    lastAccess: Date.now(),
    storedAt: header.storedAt,
    inferredMs,
  });
  memoryPut(indexKey(imageClass, hash), body, header.contentType, header.storedAt, etag, header.upstream);

  const expiresAt = getEntryExpiryFrom(key, header.storedAt, inferredMs);
  return {
    contentType: header.contentType,
    storedAt: header.storedAt,
    expired: false,
    expiresAt,
    hash,
    etag,
    size: body.length,
    upstream: header.upstream,
    body,
  };
}

async function remove(imageClass: ImageClass, hash: string): Promise<number> {
  const freed = removeFromIndex(imageClass, hash);
  memoryDrop(indexKey(imageClass, hash));
  const file = entryPath(imageClass, hash);
  await fsp.unlink(file).catch(() => { /* already gone */ });
  // Without this the sharded directories outlive their entries, and every scan
  // pays to walk a tree of directories that hold nothing.
  await pruneEmptyDirs(path.dirname(file), path.join(getCacheDir(), imageClass));
  return freed;
}

/** `BYPASS` means the bytes were served but deliberately not kept. */
export type CacheStatus = 'HIT' | 'MISS' | 'STALE' | 'REVALIDATED' | 'BYPASS';

export interface FetchResult {
  entry: CacheEntry;
  status: CacheStatus;
}

export type ImageProducer = (validators?: ConditionalValidators) => Promise<FetchOutcome>;

async function materialise(entry: CacheEntry): Promise<Buffer> {
  if (entry.body) return entry.body;
  const chunks: Buffer[] = [];
  for await (const chunk of entry.openStream!()) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function dropAndServe(
  imageClass: ImageClass,
  key: string,
  produced: { body: Buffer; contentType: string; upstream?: UpstreamCacheMeta }
): Promise<FetchResult> {
  const hash = hashKey(key);
  await remove(imageClass, hash);
  const now = Date.now();
  return {
    entry: {
      body: produced.body,
      contentType: produced.contentType,
      storedAt: now,
      expired: false,
      expiresAt: now,
      hash,
      etag: hashBody(produced.body),
      size: produced.body.length,
      upstream: produced.upstream,
    },
    status: 'BYPASS',
  };
}

/**
 * An expired entry is answered at once and refreshed behind the request, since a
 * slow origin would otherwise hold every client until its timeout only to be
 * served the same bytes. The warmer waits instead, so its concurrency cap holds.
 */
export async function getOrFetch(
  imageClass: ImageClass,
  key: string,
  producer: ImageProducer,
  options: { awaitRefresh?: boolean; shaped?: boolean } = {}
): Promise<FetchResult> {
  const cached = await get(imageClass, key);
  if (cached && !cached.expired) return { entry: cached, status: 'HIT' };
  const serveStale = !!cached && !options.awaitRefresh;
  // Opened now, before a refresh behind it can replace the file it reads.
  const stale = (): FetchResult => {
    const opened = cached!.body || !cached!.openStream ? undefined : cached!.openStream();
    return { entry: opened ? { ...cached!, openStream: () => opened } : cached!, status: 'STALE' };
  };

  const lockKey = indexKey(imageClass, hashKey(key));
  const existing = inflight.get(lockKey);
  if (existing) return serveStale ? stale() : existing;

  const store = async (produced: { body: Buffer; contentType: string; upstream?: UpstreamCacheMeta }) => {
    if (isNotStorable(key, produced.upstream)) return dropAndServe(imageClass, key, produced);

    const etag = await put(imageClass, key, produced.body, produced.contentType, produced.upstream);
    const storedAt = Date.now();
    return {
      entry: {
        body: produced.body,
        contentType: produced.contentType,
        storedAt,
        expired: false,
        expiresAt: getEntryExpiry(key, storedAt, produced.upstream),
        hash: hashKey(key),
        etag,
        size: produced.body.length,
        upstream: produced.upstream,
      },
      status: 'MISS' as CacheStatus,
    };
  };

  const task = (async (): Promise<FetchResult> => {
    try {
      let produced = await producer(revalidationHint(cached));
      if (!isNotModified(produced)) {
        if (imageClass === 'poster' && !options.shaped) produced = { ...produced, ...(await shapePoster(produced.body, produced.contentType)) };
        return await store(produced);
      }

      const merged = mergeRevalidated(cached?.upstream, produced.upstream);

      // A 304 can carry the moment the origin starts refusing to be cached, so
      // this has to be checked here as well as on the body path.
      if (cached && isNotStorable(key, merged)) {
        return await dropAndServe(imageClass, key, {
          body: await materialise(cached),
          contentType: cached.contentType,
          upstream: merged,
        });
      }

      if (cached && resolveEntryTtlMs(key, merged) === 0 && sameValidators(cached.upstream, merged)) {
        return { entry: cached, status: 'REVALIDATED' };
      }

      const refreshed = await refreshStoredEntry(imageClass, key, merged);
      if (refreshed) return { entry: refreshed, status: 'REVALIDATED' };

      const retried = await producer();
      if (isNotModified(retried)) {
        logger.warn(`${imageClass} entry vanished and upstream still answered 304: ${key}`);
        throw new Error('Upstream answered 304 with no cached entry to refresh');
      }
      return await store(retried);
    } catch (error: any) {
      if (cached) {
        logger.debug(`Serving stale ${imageClass} entry after upstream error: ${error?.message}`);
        return { entry: cached, status: 'STALE' };
      }
      throw error;
    } finally {
      inflight.delete(lockKey);
    }
  })();

  inflight.set(lockKey, task);
  if (serveStale) {
    task.catch((error: any) => logger.debug(`Background refresh of ${imageClass} failed: ${error?.message}`));
    return stale();
  }
  return task;
}

export function isCachedFresh(imageClass: ImageClass, key: string): boolean {
  const entry = index.get(indexKey(imageClass, hashKey(key)));
  if (!entry) return false;
  return Date.now() <= getEntryExpiryFrom(key, entry.storedAt, entry.inferredMs);
}

/** Bytes eviction will not take ahead of the rest: pinned entries and those used since `since`. */
export function bytesHeldSince(since: number): number {
  let bytes = 0;
  for (const entry of index.values()) {
    if (entry.lastAccess >= since || isPinned(entry.imageClass, entry.hash)) bytes += entry.size;
  }
  return bytes;
}

/** Counts an entry as used now, so eviction takes the ones nobody has wanted first. */
export function markWanted(imageClass: ImageClass, key: string): void {
  const hash = hashKey(key);
  const entry = index.get(indexKey(imageClass, hash));
  if (entry) touch(imageClass, hash, entryPath(imageClass, hash), entry.size);
}

export function capacityUsed(): { bytes: number; max: number; ratio: number } {
  const bytes = totalBytes();
  const max = getMaxBytes();
  return { bytes, max, ratio: max > 0 ? bytes / max : 0 };
}

export interface InvalidateResult {
  removed: ImageClass[];
  freed_bytes: number;
}

export async function invalidate(key: string, imageClass?: ImageClass): Promise<InvalidateResult> {
  const targets = imageClass ? [imageClass] : IMAGE_CLASSES;
  const hash = hashKey(key);
  const removed: ImageClass[] = [];
  let freed = 0;

  for (const target of targets) {
    const known = index.has(indexKey(target, hash));
    let present = known;
    if (!present) {
      present = await fsp.access(entryPath(target, hash)).then(() => true).catch(() => false);
    }
    if (!present) continue;

    freed += await remove(target, hash);
    removed.push(target);
    for (const copy of sizedKeys(key)) {
      const copyHash = hashKey(copy);
      if (index.has(indexKey(target, copyHash))) freed += await remove(target, copyHash);
    }
  }

  if (removed.length > 0) {
    logger.info(`Invalidated ${key} in ${removed.join(', ')}`);
  }
  return { removed, freed_bytes: freed };
}

export interface PurgeResult {
  success: boolean;
  message: string;
  freed_bytes: number;
  cleared: ImageClass[];
}

/** Purges one class subtree, or the whole cache when `imageClass` is omitted. */
export async function purge(imageClass?: ImageClass): Promise<PurgeResult> {
  const targets = imageClass ? [imageClass] : IMAGE_CLASSES;
  let freed = 0;

  for (const target of targets) {
    freed += totalsFor(target).bytes;
    await fsp.rm(path.join(getCacheDir(), target), { recursive: true, force: true }).catch((error: any) => {
      logger.warn(`Failed to purge ${target}: ${error?.message}`);
    });
    classTotals.set(target, { count: 0, bytes: 0 });
    const prefix = `${target}/`;
    for (const key of index.keys()) {
      if (key.startsWith(prefix)) index.delete(key);
    }
    memoryClear(prefix);
  }

  await fsp.mkdir(getCacheDir(), { recursive: true }).catch(() => { /* recreated lazily on put */ });

  const label = imageClass ? `${imageClass} images` : 'all cached images';
  logger.info(`Purged ${label} (${formatSize(freed)} freed)`);
  return {
    success: true,
    message: `Purged ${label}`,
    freed_bytes: freed,
    cleared: targets,
  };
}

async function readEntryIdentity(
  imageClass: ImageClass,
  hash: string
): Promise<{ key: string; size: number } | null> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(entryPath(imageClass, hash), 'r');
  } catch {
    return null;
  }

  try {
    const stat = await handle.stat();
    const probeLength = Math.min(HEADER_PROBE_BYTES, stat.size);
    const probe = Buffer.alloc(probeLength);
    await handle.read(probe, 0, probeLength, 0);

    const framing = readFraming(probe);
    if (!framing) return null;

    let headerJson: Buffer;
    if (framing.bodyOffset <= probeLength) {
      headerJson = probe.subarray(HEADER_OFFSET, framing.bodyOffset);
    } else {
      headerJson = Buffer.alloc(framing.headerLen);
      await handle.read(headerJson, 0, framing.headerLen, HEADER_OFFSET);
    }

    const header: EntryHeader = JSON.parse(headerJson.toString('utf8'));
    if (typeof header.key !== 'string') return null;
    return { key: header.key, size: stat.size };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => { /* already closing */ });
  }
}


const WALK_CONCURRENCY = 64;


async function walkClass(
  imageClass: ImageClass,
  worker: (hash: string) => Promise<void>
): Promise<void> {
  const hashes = eachStoredHash(imageClass)[Symbol.asyncIterator]();
  let stop = false;
  await Promise.all(Array.from({ length: WALK_CONCURRENCY }, async () => {
    for (;;) {
      if (stop) return;
      const next = await hashes.next();
      if (next.done) return;
      try {
        await worker(next.value);
      } catch (error: any) {
        stop = true;
        logger.warn(`Walk of ${imageClass} stopped at ${next.value}: ${error?.message}`);
        return;
      }
    }
  }));
}

/** Walks a class subtree. Reads the tree rather than the index, so cold entries count. */
async function* eachStoredHash(imageClass: ImageClass): AsyncGenerator<string> {
  const classDir = path.join(getCacheDir(), imageClass);
  const files = walkFiles(classDir, {
    onError: (error: any, dir: string) => logger.warn(`Could not walk ${dir}: ${error?.message}`)
  });
  for await (const file of files) {
    if (!/^[0-9a-f]{64}$/.test(file.name)) continue;
    yield file.name;
  }
}

export interface DomainPurgeResult {
  success: boolean;
  message: string;
  domain: string;
  removed: number;
  freed_bytes: number;
}


export async function purgeDomain(domain: string): Promise<DomainPurgeResult> {
  const target = (domain || '').trim().toLowerCase().replace(/^\.+/, '');
  if (!target) {
    // Guarded rather than treated as "match everything": that is `purge()`, and
    // it should have to be asked for by name.
    return { success: false, message: 'A domain is required', domain, removed: 0, freed_bytes: 0 };
  }

  let removed = 0;
  let freed = 0;

  for (const imageClass of IMAGE_CLASSES) {
    await walkClass(imageClass, async (hash) => {
      const identity = await readEntryIdentity(imageClass, hash);
      if (!identity) return;
      const host = hostFromKey(identity.key);
      if (!host || (host !== target && !host.endsWith(`.${target}`))) return;

      const indexed = await remove(imageClass, hash);
      freed += indexed || identity.size;
      removed += 1;
    });
  }

  logger.info(`Purged ${removed} entries for ${target} (${formatSize(freed)} freed)`);
  return {
    success: true,
    message: `Purged ${removed} cached image${removed === 1 ? '' : 's'} for ${target}`,
    domain: target,
    removed,
    freed_bytes: freed,
  };
}

export interface DomainPurgeStatus {
  domain: string;
  running: boolean;
  removed: number;
  freed_bytes: number;
  started_at: number;
}

let purgeState: DomainPurgeStatus | null = null;
let purgeTask: Promise<void> | null = null;


export function startDomainPurge(domain: string): DomainPurgeStatus {
  const target = (domain || '').trim().toLowerCase().replace(/^\.+/, '');
  if (!target) throw new Error('A domain is required');
  if (purgeState?.running) return purgeState;

  purgeState = { domain: target, running: true, removed: 0, freed_bytes: 0, started_at: Date.now() };
  purgeTask = (async () => {
    try {
      const result = await purgeDomain(target);
      purgeState = {
        ...purgeState!, running: false, removed: result.removed, freed_bytes: result.freed_bytes,
      };
    } catch (error: any) {
      logger.warn(`Domain purge for ${target} failed: ${error?.message}`);
      purgeState = { ...purgeState!, running: false };
    }
  })();
  return purgeState;
}

export function domainPurgeStatus(): DomainPurgeStatus | null {
  return purgeState;
}

/** Test-only: settle the in-flight walk. */
export function awaitDomainPurge(): Promise<void> {
  return purgeTask ?? Promise.resolve();
}

export interface ClassStats {
  count: number;
  bytes: number;
  human: string;
}

/** The flat validity, unannotated. */
function flatDefault(): string {
  const days = getEntryTtlDays();
  return days > 0 ? `${days}d` : 'never';
}

/** As reported on the dashboard card. */
function describeTtl(): string {
  const base = flatDefault();
  return isInferTtlEnabled() ? `${base} (origin where inferable)` : base;
}

export function stats(): Record<string, any> {
  const byType: Record<string, ClassStats> = {};
  for (const imageClass of IMAGE_CLASSES) {
    const totals = classTotals.get(imageClass);
    if (!totals || totals.count === 0) continue;
    byType[imageClass] = {
      count: totals.count,
      bytes: totals.bytes,
      human: formatSize(totals.bytes),
    };
  }

  const bytes = totalBytes();
  const budget = getMemoryBudget();
  return {
    cached_images: totalCount(),
    disk_usage: formatSize(bytes),
    disk_usage_bytes: bytes,
    max_size: getMaxSizeRaw(),
    ttl: describeTtl(),
    ttl_days: getEntryTtlDays(),
    inactive: `${getInactiveDays()}d`,
    by_type: byType,
    scanning,
    memory: {
      enabled: budget > 0,
      images: memory.size,
      usage: formatSize(memoryBytes),
      usage_bytes: memoryBytes,
      max_size: budget > 0 ? getMemorySizeRaw() : '0',
      hits: memoryHits,
    },
  };
}

/** Eviction trims the cache to this share of its budget. */
export const EVICT_TO = 0.9;

function scheduleEviction(): void {
  if (evicting) return;
  if (totalBytes() <= getMaxBytes()) return;
  evicting = true;
  setImmediate(() => {
    evict()
      .catch((error: any) => logger.warn(`Eviction failed: ${error?.message}`))
      .finally(() => { evicting = false; });
  });
}

// Entries a configuration relies on, such as a collection layout's covers,
// keyed `class:hash` to the configurations holding them. Kept out of eviction.
const pins = new Map<string, Set<string>>();

function pinsFile(): string {
  return path.join(getCacheDir(), 'pins.json');
}

async function loadPins(): Promise<void> {
  try {
    const raw = JSON.parse(await fsp.readFile(pinsFile(), 'utf8'));
    pins.clear();
    for (const [key, owners] of Object.entries(raw || {})) {
      if (Array.isArray(owners) && owners.length) pins.set(key, new Set(owners.map(String)));
    }
  } catch {
    pins.clear();
  }
}

async function savePins(): Promise<void> {
  const out: Record<string, string[]> = {};
  for (const [key, owners] of pins) out[key] = [...owners];
  await fsp.writeFile(pinsFile(), JSON.stringify(out)).catch((error: any) => logger.warn(`Could not save pins: ${error?.message}`));
}

export function isPinned(imageClass: ImageClass, hash: string): boolean {
  return pins.has(indexKey(imageClass, hash));
}

/** Replaces what one owner pins; an empty list releases everything it held. */
export async function setPins(owner: string, keys: Array<{ imageClass: ImageClass; key: string }>): Promise<void> {
  const wanted = new Set(keys.map(({ imageClass, key }) => indexKey(imageClass, hashKey(key))));
  for (const [key, owners] of [...pins]) {
    if (!wanted.has(key) && owners.delete(owner) && owners.size === 0) pins.delete(key);
  }
  for (const key of wanted) {
    const owners = pins.get(key) ?? new Set<string>();
    owners.add(owner);
    pins.set(key, owners);
  }
  await savePins();
}

export function pinnedCount(): number {
  return pins.size;
}

async function evict(): Promise<void> {
  const maxBytes = getMaxBytes();
  if (totalBytes() <= maxBytes) return;

  const target = Math.floor(maxBytes * EVICT_TO);
  const candidates = [...index.values()]
    .filter((entry) => !isPinned(entry.imageClass, entry.hash))
    .sort((a, b) => a.lastAccess - b.lastAccess);

  let removed = 0;
  let current = totalBytes();
  for (const candidate of candidates) {
    if (current <= target) break;
    current -= await remove(candidate.imageClass, candidate.hash);
    removed += 1;
  }

  if (removed > 0) {
    logger.info(`Evicted ${removed} entries, now at ${formatSize(totalBytes())} of ${getMaxSizeRaw()}`);
  }
}

/** Drops entries untouched for POSTER_CACHE_INACTIVE_DAYS (nginx `inactive=`). */
async function sweepInactive(): Promise<void> {
  const cutoff = Date.now() - getInactiveDays() * 24 * 60 * 60 * 1000;
  const stale = [...index.values()].filter((entry) => entry.lastAccess < cutoff && !isPinned(entry.imageClass, entry.hash));
  for (const entry of stale) {
    await remove(entry.imageClass, entry.hash);
  }
  if (stale.length > 0) {
    logger.info(`Swept ${stale.length} inactive entries`);
  }
}

/** Rebuilds the index from disk. Only stat() is needed — never a file read. */
async function scan(): Promise<void> {
  const root = getCacheDir();
  scanning = true;
  const started = Date.now();
  let found = 0;

  for (const imageClass of IMAGE_CLASSES) {
    const classDir = path.join(root, imageClass);
    const files = walkFiles(classDir, {
      onError: (error: any, dir: string) => logger.warn(`Could not scan ${dir}: ${error?.message}`)
    });

    // Stats run many at a time.
    const width = envInt('POSTER_CACHE_SCAN_CONCURRENCY', 32, 1);
    let batch: string[] = [];
    const statBatch = async () => {
      const names = batch;
      batch = [];
      await Promise.all(names.map(async (name) => {
        try {
          const stat = await fsp.stat(entryPath(imageClass, name));
          addToIndex({
            imageClass,
            hash: name,
            size: stat.size,
            lastAccess: stat.atimeMs,
            storedAt: stat.mtimeMs,
            inferredMs: null,
          });
          found += 1;
        } catch {
          // Vanished between readdir and stat — nothing to index.
        }
      }));
    };
    for await (const { name, dir } of files) {
      if (name.endsWith('.tmp')) {
        // Interrupted write from a previous run.
        await fsp.unlink(path.join(dir, name)).catch(() => { /* best effort */ });
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      batch.push(name);
      if (batch.length >= width) await statBatch();
    }
    if (batch.length) await statBatch();
  }

  scanning = false;
  logger.info(`Indexed ${found} cached images (${formatSize(totalBytes())}) in ${Date.now() - started}ms`);
  scheduleEviction();
}

async function backfillIds(): Promise<void> {
  if (idIndexing || idIndexBuilt) return;
  idIndexing = true;
  const started = Date.now();
  let read = 0;

  try {
    const pending = [...index].filter(([, entry]) => entry.ids === undefined);
    const width = 16;
    for (let i = 0; i < pending.length; i += width) {
      await Promise.all(pending.slice(i, i + width).map(async ([, entry]) => {
        const file = entryPath(entry.imageClass, entry.hash);
        const stored = await readStoredHeader(entry.imageClass, entry.hash, file);
        entry.ids = stored?.header?.key ? extractIdTokens(stored.header.key) : [];
        read += 1;
      }));
      if (i % (width * 32) === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    idIndexBuilt = true;
    const searchable = [...index.values()].filter((e) => (e.ids?.length ?? 0) > 0).length;
    logger.info(
      `Read ids from ${read} images in ${Date.now() - started}ms — ${searchable} carry a media id`
    );
  } finally {
    idIndexing = false;
  }
}

export interface IdSearchability {
  total: number;
  searchable: number;
  unsearchable: number;
  unsearchableByClass: Record<string, number>;
}

export function idSearchability(): IdSearchability {
  const byClass: Record<string, number> = {};
  let searchable = 0;
  let unsearchable = 0;
  for (const entry of index.values()) {
    if ((entry.ids?.length ?? 0) > 0) {
      searchable += 1;
    } else {
      unsearchable += 1;
      byClass[entry.imageClass] = (byClass[entry.imageClass] || 0) + 1;
    }
  }
  return { total: index.size, searchable, unsearchable, unsearchableByClass: byClass };
}

export interface InvalidateByIdResult {
  id: string;
  removed: number;
  freed_bytes: number;
  clearedByClass: Record<string, number>;
  searchability: IdSearchability;
}

export async function invalidateByMediaId(rawId: string): Promise<InvalidateByIdResult> {
  const token = /^tt/i.test(rawId.trim()) ? rawId.trim().toLowerCase() : rawId.trim();
  await backfillIds();

  const doomed: IndexEntry[] = [];
  for (const entry of index.values()) {
    if (entry.ids && entry.ids.includes(token)) doomed.push(entry);
  }

  const clearedByClass: Record<string, number> = {};
  let freed = 0;
  for (const entry of doomed) {
    freed += await remove(entry.imageClass, entry.hash);
    clearedByClass[entry.imageClass] = (clearedByClass[entry.imageClass] || 0) + 1;
  }

  return {
    id: token,
    removed: doomed.length,
    freed_bytes: freed,
    clearedByClass,
    searchability: idSearchability(),
  };
}

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await fsp.mkdir(getCacheDir(), { recursive: true }).catch((error: any) => {
    logger.warn(`Could not create cache dir: ${error?.message}`);
  });

  await loadPins();
  indexed = scan().catch((error: any) => logger.warn(`Initial scan failed: ${error?.message}`));

  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      sweepInactive().catch((error: any) => logger.warn(`Sweep failed: ${error?.message}`));
    }, 60 * 60 * 1000);
    sweepTimer.unref?.();
  }

  const budget = getMemoryBudget();
  logger.info(
    `Built-in poster cache active at ${getCacheDir()} ` +
    `(disk ${getMaxSizeRaw()}, memory ${budget > 0 ? getMemorySizeRaw() : 'disabled — disk only'}, ` +
    `validity ${describeTtl()})`
  );
}

export function isInitialized(): boolean {
  return initialized;
}
