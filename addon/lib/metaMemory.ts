import { AsyncLocalStorage } from 'node:async_hooks';
import { LRUCache } from 'lru-cache';
import { envInt } from '../utils/envNumber';

export interface HashRead {
  texts: Array<string | null>;
  basicTtl: number;
}

interface HeldHash {
  fields: Map<string, string | null>;
  basicTtl: number;
  readAt: number;
  expiresAt: number;
}

interface HeldPage {
  text: string;
  deps: string[];
  at: number;
}

interface PageReads {
  deps: Set<string>;
  minTtl: number;
  settled: boolean;
}

type Loader = (fields: string[]) => Promise<HashRead>;

let hashes: LRUCache<string, HeldHash> | null | undefined;
let aliases: LRUCache<string, { value: string | null }> | null | undefined;
const loading = new Map<string, Promise<HashRead>>();
const aliasLoading = new Map<string, Promise<string | null>>();
let pages: LRUCache<string, HeldPage> | null | undefined;
const pageLoading = new Map<string, Promise<string>>();
const pageReads = new AsyncLocalStorage<PageReads>();
let writes = 0;
let clearedAt = 0;
let evictedWrite = 0;
const lastWrite = new LRUCache<string, number>({
  max: 200000,
  dispose: (value, _key, reason) => {
    if (reason === 'evict' && value > evictedWrite) evictedWrite = value;
  },
});

function changedSince(key: string, startedAt: number): boolean {
  return clearedAt > startedAt || (lastWrite.get(key) ?? evictedWrite) > startedAt;
}

function noteRead(key: string, basicTtl?: number): void {
  const reads = pageReads.getStore();
  if (!reads) return;
  reads.deps.add(key);
  if (basicTtl !== undefined && basicTtl >= 0 && basicTtl < reads.minTtl) reads.minTtl = basicTtl;
}

function ttlMs(): number {
  return envInt('META_MEMORY_CACHE_TTL', 300, 1) * 1000;
}

function sizeOf(entry: HeldHash): number {
  let bytes = 96;
  for (const [field, text] of entry.fields) bytes += 32 + field.length + (text?.length ?? 0);
  return bytes;
}

function store(): LRUCache<string, HeldHash> | null {
  if (hashes !== undefined) return hashes;
  const megabytes = envInt('META_MEMORY_CACHE_MB', 256, 0);
  hashes = megabytes > 0
    ? new LRUCache<string, HeldHash>({ maxSize: megabytes * 1024 * 1024, sizeCalculation: sizeOf })
    : null;
  aliases = megabytes > 0 ? new LRUCache<string, { value: string | null }>({ max: 200000, ttl: ttlMs() }) : null;
  return hashes;
}

function remainingTtl(entry: HeldHash, now: number): number {
  if (entry.basicTtl < 0) return entry.basicTtl;
  return Math.max(0, entry.basicTtl - Math.floor((now - entry.readAt) / 1000));
}

function expiryFor(basicTtl: number, now: number): number {
  const cap = now + ttlMs();
  return basicTtl > 0 ? Math.min(cap, now + basicTtl * 1000) : cap;
}

function heldEntry(cache: LRUCache<string, HeldHash>, key: string, now: number): HeldHash | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

function keep(cache: LRUCache<string, HeldHash>, key: string, previous: HeldHash | undefined, fields: string[], read: HashRead, now: number): HeldHash {
  const merged = new Map(previous?.fields ?? []);
  fields.forEach((field, index) => merged.set(field, read.texts[index]));
  const expiresAt = previous ? Math.min(previous.expiresAt, expiryFor(read.basicTtl, now)) : expiryFor(read.basicTtl, now);
  const entry: HeldHash = { fields: merged, basicTtl: read.basicTtl, readAt: now, expiresAt };
  if (expiresAt > now) cache.set(key, entry, { ttl: expiresAt - now });
  return entry;
}

export async function readHeldHash(key: string, fields: string[], load: Loader): Promise<HashRead> {
  const cache = store();
  if (!cache || fields.length === 0) return load(fields);
  noteRead(key);

  const now = Date.now();
  const held = heldEntry(cache, key, now);
  const missing = held ? fields.filter((field) => !held.fields.has(field)) : fields;
  if (held && missing.length === 0) {
    const basicTtl = remainingTtl(held, now);
    noteRead(key, basicTtl);
    return { texts: fields.map((field) => held.fields.get(field) ?? null), basicTtl };
  }

  const startedAt = writes;
  const flightKey = `${key}\u0000${missing.join('\u0000')}`;
  let flight = loading.get(flightKey);
  if (!flight) {
    flight = load(missing).finally(() => loading.delete(flightKey));
    loading.set(flightKey, flight);
  }
  const read = await flight;

  if (changedSince(key, startedAt)) return load(fields);

  noteRead(key, read.basicTtl);
  const after = Date.now();
  const entry = keep(cache, key, heldEntry(cache, key, after), missing, read, after);
  return { texts: fields.map((field) => entry.fields.get(field) ?? null), basicTtl: read.basicTtl };
}

export async function readHeldAlias(key: string, load: () => Promise<string | null>): Promise<string | null> {
  store();
  if (!aliases) return load();
  noteRead(key);
  const held = aliases.get(key);
  if (held) return held.value;

  const startedAt = writes;
  let flight = aliasLoading.get(key);
  if (!flight) {
    flight = load().finally(() => aliasLoading.delete(key));
    aliasLoading.set(key, flight);
  }
  const value = await flight;
  if (!changedSince(key, startedAt)) aliases.set(key, { value });
  return value;
}

export function forgetHeld(key: string): void {
  writes += 1;
  lastWrite.set(key, writes);
  hashes?.delete(key);
  aliases?.delete(key);
}

export function forgetAllHeld(): void {
  writes += 1;
  clearedAt = writes;
  hashes?.clear();
  aliases?.clear();
  pages?.clear();
  lastWrite.clear();
}

export function markUnsettled(): void {
  const reads = pageReads.getStore();
  if (reads) reads.settled = false;
}

function pageStore(): LRUCache<string, HeldPage> | null {
  if (pages !== undefined) return pages;
  const megabytes = envInt('CATALOG_PAGE_MEMORY_MB', 64, 0);
  pages = megabytes > 0 && store()
    ? new LRUCache<string, HeldPage>({ maxSize: megabytes * 1024 * 1024, sizeCalculation: (page) => 64 + page.text.length + page.deps.reduce((bytes, dep) => bytes + 16 + dep.length, 0) })
    : null;
  return pages;
}

function currentPage(cache: LRUCache<string, HeldPage>, key: string): HeldPage | undefined {
  const page = cache.get(key);
  if (!page) return undefined;
  if (page.deps.some((dep) => changedSince(dep, page.at))) {
    cache.delete(key);
    return undefined;
  }
  return page;
}

async function buildPage<T>(cache: LRUCache<string, HeldPage>, key: string, build: () => Promise<T>): Promise<string> {
  const startedAt = writes;
  const reads: PageReads = { deps: new Set(), minTtl: Infinity, settled: true };
  const text = JSON.stringify(await pageReads.run(reads, build));
  const deps = [...reads.deps];
  if (reads.settled && !deps.some((dep) => changedSince(dep, startedAt))) {
    const ttl = Math.min(ttlMs(), reads.minTtl * 1000);
    if (ttl > 0) cache.set(key, { text, deps, at: startedAt }, { ttl });
  }
  return text;
}

export async function readHeldPage<T>(key: string, build: () => Promise<T>): Promise<T> {
  const cache = pageStore();
  if (!cache) return build();

  const held = currentPage(cache, key);
  if (held) return JSON.parse(held.text);

  let flight = pageLoading.get(key);
  if (!flight) {
    flight = buildPage(cache, key, build).finally(() => pageLoading.delete(key));
    pageLoading.set(key, flight);
  }
  return JSON.parse(await flight);
}

export function heldStats(): { entries: number; bytes: number; aliases: number; pages: number; pageBytes: number } {
  return { entries: hashes?.size ?? 0, bytes: hashes?.calculatedSize ?? 0, aliases: aliases?.size ?? 0, pages: pages?.size ?? 0, pageBytes: pages?.calculatedSize ?? 0 };
}
