// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import consola from 'consola';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';

const MANIFEST_TTL_MS = 10 * 60 * 1000;
const FAILURE_MS = 30 * 1000;
const READ_TIMEOUT_MS = 5000;
const MAX_BASES = 500;

export type Manifest = Record<string, any>;

export interface AddonReaderOptions {
  userAgent: () => string;
  fetch: (url: string, init: Record<string, any>) => Promise<any>;
  readBody: (response: any) => Promise<string>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface AddonDeps {
  manifest(base: string): Promise<Manifest | null>;
  peek(base: string): Manifest | undefined;
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
      if (!manifest) {
        failures.set(key, true);
        throw new Error('manifest read failed');
      }
      return manifest;
    },
  });

  function read(base: string): Promise<Manifest | null> {
    const key = hash(base);
    const failed = () => {
      failures.set(key, true);
      return null;
    };
    return manifests.fetch(key, { context: base }).then((manifest) => manifest ?? failed(), failed);
  }

  function held(key: string): Manifest | undefined {
    return manifests.peek(key, { allowStale: true });
  }

  return {
    now,
    fetchJson,
    manifest(base: string) {
      const key = hash(base);
      if (failures.has(key)) return Promise.resolve(held(key) ?? null);
      return read(base);
    },
    peek(base: string) {
      const key = hash(base);
      const manifest = held(key);
      if (!failures.has(key) && (manifest === undefined || manifests.getRemainingTTL(key) <= 0)) void read(base);
      return manifest;
    },
  };
}
