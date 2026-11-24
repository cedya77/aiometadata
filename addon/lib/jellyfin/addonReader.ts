// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';

const MANIFEST_TTL_MS = 10 * 60 * 1000;
const FAILURE_MS = 30 * 1000;
const READ_TIMEOUT_MS = 5000;
const MAX_BASES = 500;
const STORE_TIMEOUT_MS = 500;

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
  log?: (line: string) => void;
  /** Where the live part of each manifest outlasts the process. */
  store?: ManifestStore;
}

export interface AddonDeps {
  manifest(base: string): Promise<Manifest | null>;
  peek(base: string): Manifest | undefined;
  /** Holds what the store kept of the manifest, as a stale one, when none is held. Never reads the addon. */
  recall(base: string): Promise<void>;
  fetchJson(base: string, path: string): Promise<any | null>;
  now(): number;
}

const logger = consola.withTag('JellyfinLiveTv');

export function hash(base: string): string {
  return createHash('sha256').update(base).digest('hex');
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

export function clockOptions(now?: () => number): { perf?: { now: () => number }; ttlResolution?: number } {
  return now ? { perf: { now }, ttlResolution: 0 } : {};
}

const isManifest = (body: any): body is Manifest => Array.isArray(body?.catalogs);

function livePart(manifest: Manifest): Manifest {
  const hints = manifest.behaviorHints ?? {};
  const catalogs = manifest.catalogs
    .filter((c: any) => c?.type === 'tv' || extrasOf(c).some((e) => e.name === 'date'))
    .map((c: any) => ({ type: c.type, id: c.id, name: c.name, extra: extrasOf(c) }));
  return { behaviorHints: { epgProvider: hints.epgProvider, catchupDays: hints.catchupDays }, catalogs };
}

/** The extras a catalog declares, as objects or the older way, as lists of names. */
export function extrasOf(catalog: any): Array<{ name: string; isRequired?: boolean }> {
  const extras = new Map<string, { name: string; isRequired?: boolean }>();
  for (const extra of Array.isArray(catalog?.extra) ? catalog.extra : []) {
    if (typeof extra?.name === 'string') extras.set(extra.name, { name: extra.name, isRequired: Boolean(extra.isRequired) });
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

  async function fetchJson(base: string, path: string): Promise<any | null> {
    const host = hostOf(base);
    const where = `${host} ${path.split('/').slice(0, 3).join('/')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await options.fetch(`${base}${path}`, {
        headers: { accept: 'application/json', 'user-agent': options.userAgent() },
        signal: controller.signal,
      });
      if (!response?.ok) {
        await response?.body?.cancel?.().catch(() => undefined);
        log(`Addon read ${where} returned ${response?.status}`);
        return null;
      }
      const body = JSON.parse(await options.readBody(response));
      return body && typeof body === 'object' ? body : null;
    } catch (error: any) {
      const reason = error?.name === 'AbortError' ? 'timed out' : String(error?.code || error?.name || 'failed');
      log(`Addon read ${where} failed: ${reason}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const failures = new LRUCache<string, true>({ max: MAX_BASES, ttl: FAILURE_MS, ...clockOptions(options.now) });
  const manifests = new LRUCache<string, Manifest, string>({
    max: MAX_BASES,
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
      options.store?.set(storeKey(key), JSON.stringify(livePart(manifest))).catch(() => undefined);
      recalled.delete(key);
      return manifest;
    },
  });
  // Apart from the manifests read: setting one there ends a read of it that is still running.
  const recalled = new LRUCache<string, Manifest>({ max: MAX_BASES });

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
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), STORE_TIMEOUT_MS);
      });
      try {
        const stored = await Promise.race([options.store.get(storeKey(key)), late]);
        const manifest = stored ? JSON.parse(stored) : null;
        if (isManifest(manifest) && held(key) === undefined) recalled.set(key, manifest);
      } catch (error: any) {
        log(`Addon manifest recall for ${hostOf(base)} failed: ${error?.code || error?.name || 'failed'}`);
      } finally {
        clearTimeout(timer);
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
