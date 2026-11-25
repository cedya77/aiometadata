// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';

const MANIFEST_TTL_MS = 10 * 60 * 1000;
const FAILURE_MS = 30 * 1000;
const READ_TIMEOUT_MS = 5000;
const MAX_BASES = 5000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_CATALOGS = 50;
const MAX_OPTIONS = 5000;
const MAX_OPTION = 200;
const MAX_MANIFEST = 256 * 1024;
const STORE_TIMEOUT_MS = 500;
// Servers behind one address may count apart, so the first pause is short. Both outlast a limit over 5 s.
const PAUSE_MS = 1000;
const NEXT_PAUSE_MS = 4000;
const SPREAD_MS = 300;

export type Manifest = Record<string, any>;

export interface ManifestStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export interface AddonReaderOptions {
  userAgent: () => string;
  fetch: (url: string, init: Record<string, any>) => Promise<any>;
  readBody: (response: any) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Where the live part of each manifest outlasts the process. */
  store?: ManifestStore;
}

export interface AddonDeps {
  manifest(base: string): Promise<Manifest | null>;
  peek(base: string): Manifest | undefined;
  /** Holds what the store kept of the manifest, as a stale one, when none is held. Never reads the addon. */
  recall(base: string): Promise<void>;
  /** Until `until` a catalog the addon refuses, as over its limit, is asked for again once the pause after that is over. */
  fetchJson(base: string, path: string, timeoutMs?: number, until?: number): Promise<any | null>;
  /** Whether the addon is in such a pause, so that what came back empty is no failure. */
  paused?(base: string): boolean;
  now(): number;
}

const logger = consola.withTag('JellyfinLiveTv');

const hashes = new LRUCache<string, string>({ max: 1000 });

export function hash(base: string): string {
  let held = hashes.get(base);
  if (held === undefined) {
    held = createHash('sha256').update(base).digest('hex');
    hashes.set(base, held);
  }
  return held;
}

export function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return 'addon';
  }
}

const inFlight = new Map<string, Promise<any>>();

export function shareInFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running;
  const started = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}

export async function inBatches<T>(tasks: Array<() => Promise<T>>, size: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const at = next++;
      results[at] = await tasks[at]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}

/** What is answered within `ms`, or undefined while it goes on. */
export async function inTime<T>(answer: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function clockOptions(now?: () => number): { perf?: { now: () => number }; ttlResolution?: number } {
  return now ? { perf: { now }, ttlResolution: 0 } : {};
}

/** AIOStreams answers a failure with 200 and an entry that names the error. */
export const isAddonError = (entry: any): boolean => String(entry?.id ?? '').startsWith('aiostreamserror.');

const isRefusal = (entry: any): boolean => isAddonError(entry) && /rate(%20|\W)?limit/i.test(`${entry.id} ${entry.name}`);

const isRefused = (body: any): boolean =>
  [body?.metas, body?.metasDetailed].some((list) => Array.isArray(list) && list.some(isRefusal));

const isManifest = (body: any): body is Manifest => Array.isArray(body?.catalogs);

const kept = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_OPTION;

/** What Live TV reads of a manifest, and no more of it than is kept. */
function livePart(manifest: Manifest): Manifest {
  const hints = manifest.behaviorHints ?? {};
  let room = MAX_MANIFEST;
  const fits = (value: string) => (room -= value.length + 4) >= 0;
  const catalogs: any[] = [];
  for (const c of manifest.catalogs) {
    if (catalogs.length >= MAX_CATALOGS) break;
    if (!kept(c?.type) || !kept(c?.id)) continue;
    const extra = extrasOf(c).filter((e) => kept(e.name)).slice(0, MAX_CATALOGS);
    if (c.type !== 'tv' && !extra.some((e) => e.name === 'date')) continue;
    if (![c.type, c.id, ...extra.map((e) => e.name)].every(fits)) break;
    for (const e of extra) if (e.options) e.options = e.options.slice(0, MAX_OPTIONS).filter((o): o is string => kept(o) && fits(o));
    catalogs.push({ type: c.type, id: c.id, name: kept(c.name) ? c.name : c.id, extra });
  }
  const days = Number(hints.catchupDays);
  return { behaviorHints: { epgProvider: hints.epgProvider === true, ...(Number.isFinite(days) && { catchupDays: days }) }, catalogs };
}

const manifestSize = (manifest: Manifest): number => 2 * JSON.stringify(manifest).length;

interface Extra {
  name: string;
  isRequired?: boolean;
  options?: unknown[];
}

/** The extras a catalog declares, as objects or the older way, as lists of names. */
export function extrasOf(catalog: any): Extra[] {
  const extras = new Map<string, Extra>();
  for (const extra of Array.isArray(catalog?.extra) ? catalog.extra : []) {
    if (typeof extra?.name !== 'string') continue;
    extras.set(extra.name, { name: extra.name, isRequired: Boolean(extra.isRequired) });
    if (extra.name === 'genre' && Array.isArray(extra.options)) extras.get('genre')!.options = extra.options;
  }
  for (const name of Array.isArray(catalog?.extraSupported) ? catalog.extraSupported : []) {
    if (typeof name === 'string' && !extras.has(name)) extras.set(name, { name });
  }
  for (const name of Array.isArray(catalog?.extraRequired) ? catalog.extraRequired : []) {
    if (typeof name === 'string') extras.set(name, { name, isRequired: true });
  }
  return [...extras.values()];
}

const storeKey = (key: string): string => `jf:livetv:manifest:${key}`;

export function createAddonReader(options: AddonReaderOptions): AddonDeps {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => logger.debug(line));

  async function ask(base: string, path: string, timeoutMs: number): Promise<{ body: any | null; refused: boolean }> {
    const host = hostOf(base);
    const where = `${host} ${path.split('/').slice(0, 3).join('/')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await options.fetch(`${base}${path}`, {
        headers: { accept: 'application/json', 'user-agent': options.userAgent() },
        signal: controller.signal,
      });
      if (!response?.ok) {
        await response?.body?.cancel?.().catch(() => undefined);
        log(`Addon read ${where} returned ${response?.status}`);
        return { body: null, refused: response?.status === 429 };
      }
      const body = JSON.parse(await options.readBody(response));
      return body && typeof body === 'object' ? { body, refused: isRefused(body) } : { body: null, refused: false };
    } catch (error: any) {
      const reason = error?.name === 'AbortError' ? 'timed out' : String(error?.code || error?.name || 'failed');
      log(`Addon read ${where} failed: ${reason}`);
      return { body: null, refused: false };
    } finally {
      clearTimeout(timer);
    }
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const pauses = new LRUCache<string, { until: number; again: boolean }>({ max: MAX_BASES });
  const pauseLeft = (key: string): number => (pauses.get(key)?.until ?? 0) - now();

  async function fetchJson(base: string, path: string, timeoutMs = READ_TIMEOUT_MS, until?: number): Promise<any | null> {
    if (!path.startsWith('/catalog/')) return (await ask(base, path, timeoutMs)).body;
    const key = hash(base);
    for (;;) {
      const wait = pauseLeft(key);
      if (wait > 0) {
        if (until === undefined || now() + wait > until) return null;
        await sleep(wait + Math.random() * SPREAD_MS);
        continue;
      }
      const { body, refused } = await ask(base, path, timeoutMs);
      const pause = pauses.get(key);
      if (!refused) {
        if (pause && pauseLeft(key) <= 0) pause.again = false;
        return body;
      }
      if (pauseLeft(key) <= 0) pauses.set(key, { until: now() + (pause?.again ? NEXT_PAUSE_MS : PAUSE_MS), again: true });
    }
  }

  const failures = new LRUCache<string, true>({ max: MAX_BASES, ttl: FAILURE_MS, ...clockOptions(options.now) });
  const manifests = new LRUCache<string, Manifest, string>({
    max: MAX_BASES,
    maxSize: MAX_MANIFEST_BYTES,
    sizeCalculation: manifestSize,
    ttl: MANIFEST_TTL_MS,
    allowStale: true,
    allowStaleOnFetchRejection: true,
    noDeleteOnFetchRejection: true,
    ...clockOptions(options.now),
    fetchMethod: async (key, _stale, { context }) => {
      const manifest = await fetchJson(context, '/manifest.json');
      if (!isManifest(manifest)) {
        failures.set(key, true);
        throw new Error('manifest read failed');
      }
      const part = livePart(manifest);
      options.store?.set(storeKey(key), JSON.stringify(part)).catch(() => undefined);
      recalled.delete(key);
      return part;
    },
  });
  // Apart from the manifests read: setting one there ends a read of it that is still running.
  const recalled = new LRUCache<string, Manifest>({ max: MAX_BASES, maxSize: MAX_MANIFEST_BYTES, sizeCalculation: manifestSize });

  function read(base: string): Promise<Manifest | null> {
    const key = hash(base);
    const failed = () => {
      failures.set(key, true);
      return held(key) ?? null;
    };
    return manifests.fetch(key, { context: base }).then((manifest) => manifest ?? failed(), failed);
  }

  function held(key: string): Manifest | undefined {
    return manifests.peek(key, { allowStale: true }) ?? recalled.get(key);
  }

  return {
    now,
    fetchJson,
    paused: (base: string) => pauseLeft(hash(base)) > 0,
    manifest(base: string) {
      const key = hash(base);
      if (failures.has(key)) return Promise.resolve(held(key) ?? null);
      const kept = recalled.get(key);
      const reading = read(base);
      return kept ? Promise.resolve(kept) : reading;
    },
    async recall(base: string) {
      const key = hash(base);
      if (!options.store || held(key) !== undefined) return;
      try {
        const stored = await inTime(options.store.get(storeKey(key)), STORE_TIMEOUT_MS);
        const manifest = stored ? JSON.parse(stored) : null;
        if (isManifest(manifest) && held(key) === undefined) recalled.set(key, livePart(manifest));
      } catch (error: any) {
        log(`Addon manifest recall for ${hostOf(base)} failed: ${error?.code || error?.name || 'failed'}`);
      }
    },
    peek(base: string) {
      const key = hash(base);
      const manifest = held(key);
      if (!failures.has(key) && (manifest === undefined || manifests.getRemainingTTL(key) <= 0)) void read(base);
      return manifest;
    },
  };
}
