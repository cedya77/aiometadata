import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import consola from 'consola';
import {
  formatSize,
  getWarmConcurrencyMax,
  getWarmConcurrencyMin,
  getCacheDir,
  getWarmQueueMax,
  getWarmTargetLagMs,
  isWarmQueueEnabled,
  type ImageClass,
} from './config.js';
import * as store from './store.js';
import { OversizeImage, UpstreamRejected, fetchImage } from './upstream.js';

const logger = consola.withTag('ImageWarm');

export interface WarmTarget {
  imageClass: ImageClass;
  url: string;
  http?: string;
  checkClass?: ImageClass;
  checkKey?: string;
}

interface Stats {
  offered: number;
  skipped: number;
  queued: number;
  warmed: number;
  alreadyFresh: number;
  rendered: number;
  failed: number;
  dropped: number;
  atCapacity: number;
  peakOutstanding: number;
}

/** First in, first out, dropping what it has handed out in batches so taking from the front stays cheap. */
class Lane {
  private items: WarmTarget[] = [];
  private head = 0;

  get size(): number {
    return this.items.length - this.head;
  }

  push(target: WarmTarget): void {
    this.items.push(target);
  }

  take(): WarmTarget | undefined {
    if (this.size === 0) return undefined;
    const target = this.items[this.head];
    this.head += 1;
    if (this.head > 4096 && this.head * 2 >= this.items.length) {
      this.items.splice(0, this.head);
      this.head = 0;
    }
    return target;
  }

  clear(): void {
    this.items.length = 0;
    this.head = 0;
  }
}

// Classes with many images to a title, such as a thumbnail for every episode, wait behind the rest in a lane of
// their own: they never push a poster out of the queue, and stop well short of the budget so posters keep room.
const BULK_CLASSES: ReadonlySet<ImageClass> = new Set(['thumbnail']);
const FULL_AT = 0.98;
const BULK_FULL_AT = 0.9;
const main = new Lane();
const bulk = new Lane();
const pending = new Set<string>();
/** Images already counted this run, so one poster in twenty catalogs counts once. */
const counted = new Set<string>();

let active = 0;
let desired = 0;
let draining = false;
let lagTimer: NodeJS.Timeout | null = null;
let lastTick = 0;
let observedLag = 0;
let capacityWarned = false;
let idleTimer: NodeJS.Timeout | null = null;

export interface WarmSummary extends Stats {
  at: number;
  outstanding: number;
  failures: Record<string, number>;
  /** Absent on summaries written before per class counters existed. */
  byClass?: Record<string, ClassSummary>;
}

let lastRun: WarmSummary | null = null;
let loaded = false;
let lastPersistAt = 0;
let persisting = false;

const PERSIST_THROTTLE_MS = 30000;

function summaryFile(): string {
  return path.join(getCacheDir(), 'warm-summary.json');
}

export async function loadSummary(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fsp.readFile(summaryFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.at === 'number') lastRun = parsed;
  } catch {
    lastRun = null;
  }
}

function persist(force: boolean): void {
  const now = Date.now();
  if (!force && (persisting || now - lastPersistAt < PERSIST_THROTTLE_MS)) return;
  if (stats.offered === 0) return;
  persisting = true;
  lastPersistAt = now;
  const snapshot: WarmSummary = {
    ...stats,
    at: now,
    outstanding: depth() + active,
    failures: Object.fromEntries(failureReasons),
    byClass: snapshotByClass(),
  };
  lastRun = snapshot;
  const file = summaryFile();
  fsp.mkdir(path.dirname(file), { recursive: true })
    .then(() => fsp.writeFile(`${file}.tmp`, JSON.stringify(snapshot)))
    .then(() => fsp.rename(`${file}.tmp`, file))
    .catch((error: any) => logger.debug(`Could not persist warm summary: ${error?.message}`))
    .finally(() => { persisting = false; });
}

const failureReasons = new Map<string, number>();

interface ClassStats {
  warmed: number;
  alreadyFresh: number;
  rendered: number;
  failed: number;
  failures: Map<string, number>;
}

const byClass = new Map<string, ClassStats>();

function classStats(imageClass: string): ClassStats {
  let entry = byClass.get(imageClass);
  if (!entry) {
    entry = { warmed: 0, alreadyFresh: 0, rendered: 0, failed: 0, failures: new Map() };
    byClass.set(imageClass, entry);
  }
  return entry;
}

export interface ClassSummary {
  warmed: number;
  alreadyFresh: number;
  rendered: number;
  failed: number;
  failures: Record<string, number>;
}

function snapshotByClass(): Record<string, ClassSummary> {
  const out: Record<string, ClassSummary> = {};
  for (const [imageClass, entry] of byClass) {
    out[imageClass] = {
      warmed: entry.warmed,
      alreadyFresh: entry.alreadyFresh,
      rendered: entry.rendered,
      failed: entry.failed,
      failures: Object.fromEntries(entry.failures),
    };
  }
  return out;
}

function describeFailures(failures: Map<string, number>): string {
  return [...failures]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${reason}`)
    .join(', ');
}

/** One line per class that saw work, so a failing upstream is obvious at a glance. */
function classBreakdown(): string[] {
  return [...byClass]
    .filter(([, entry]) => entry.warmed + entry.alreadyFresh + entry.rendered + entry.failed > 0)
    .sort((a, b) => (b[1].warmed + b[1].rendered) - (a[1].warmed + a[1].rendered))
    .map(([imageClass, entry]) => {
      const parts = [
        `${entry.warmed} fetched`,
        `${entry.alreadyFresh} already fresh`,
      ];
      if (entry.rendered > 0) parts.push(`${entry.rendered} rendered`);
      parts.push(`${entry.failed} failed`);
      const reasons = entry.failed > 0 ? ` (${describeFailures(entry.failures)})` : '';
      return `  ${imageClass}: ${parts.join(', ')}${reasons}`;
    });
}

function classifyFailure(error: any): string {
  if (error?.name === 'AbortError' || error?.code === 'ECONNABORTED') return 'timeout';

  // Our own guard, not the origin — reported separately so a refusal to fetch
  // is never mistaken for the provider answering.
  if (error instanceof UpstreamRejected) {
    const message = String(error.message || '').toLowerCase();
    if (message.includes('private address')) return 'blocked: private host';
    if (message.includes('could not resolve')) return 'unresolvable host';
    if (message.includes('protocol')) return 'bad url';
    return 'rejected upstream';
  }

  if (error instanceof OversizeImage) return 'too large';
  const status = error?.response?.status;
  if (typeof status === 'number') return `http ${status}`;
  if (error?.code) return String(error.code).toLowerCase();
  return 'other';
}

const stats: Stats = {
  offered: 0, skipped: 0, queued: 0, warmed: 0, alreadyFresh: 0, rendered: 0,
  failed: 0, dropped: 0, atCapacity: 0, peakOutstanding: 0,
};

function notePeak(): void {
  const outstanding = depth() + active;
  if (outstanding > stats.peakOutstanding) stats.peakOutstanding = outstanding;
}

const LAG_INTERVAL_MS = 250;

function depth(): number {
  return main.size + bulk.size;
}

function startLagProbe(): void {
  if (lagTimer) return;
  lastTick = Date.now();
  desired = getWarmConcurrencyMin();
  lagTimer = setInterval(() => {
    const now = Date.now();
    observedLag = Math.max(0, now - lastTick - LAG_INTERVAL_MS);
    lastTick = now;

    const target = getWarmTargetLagMs();
    const min = getWarmConcurrencyMin();
    const max = getWarmConcurrencyMax();

    if (observedLag > target * 2) {
      desired = Math.max(min, Math.floor(desired / 2));
    } else if (observedLag > target) {
      desired = Math.max(min, desired - 1);
    } else if (observedLag < target / 2) {
      desired = Math.min(max, desired + Math.max(1, Math.floor(desired / 4)));
    }
    pump();
  }, LAG_INTERVAL_MS);
  lagTimer.unref?.();
}

function stopLagProbe(): void {
  if (!lagTimer) return;
  clearInterval(lagTimer);
  lagTimer = null;
}

const IDLE_SETTLE_MS = 60000;
let lastReported = -1;

function scheduleIdleReport(): void {
  if (idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (depth() > 0 || active > 0) return;
    draining = false;
    stopLagProbe();
    persist(true);
    const done = stats.warmed + stats.rendered;
    if (done === lastReported) return;
    lastReported = done;
    logger.info(
      [
        `Image warming idle — ${stats.warmed} fetched, ${stats.skipped} skipped, ` +
        `${stats.alreadyFresh} already fresh, ${stats.rendered} rendered, ` +
        `${stats.failed} failed, ${stats.dropped} dropped, ${stats.atCapacity} over capacity` +
        (failureReasons.size > 0 ? ` — failures: ${describeFailures(failureReasons)}` : ''),
        ...classBreakdown(),
      ].join('\n')
    );
  }, IDLE_SETTLE_MS);
  idleTimer.unref?.();
}

function cancelIdleReport(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function keyOf(target: WarmTarget): string {
  return target.http ? `h:${target.http}` : `${target.imageClass}:${target.url}`;
}

export function offer(targets: WarmTarget[]): void {
  if (!isWarmQueueEnabled() || targets.length === 0) return;

  const max = getWarmQueueMax();
  const capacity = store.capacityUsed();
  const full = capacity.max > 0 && capacity.ratio >= FULL_AT;
  const bulkFull = capacity.max > 0 && capacity.ratio >= BULK_FULL_AT;

  if (full && !capacityWarned) {
    capacityWarned = true;
    logger.warn(
      `Image cache is at ${(capacity.ratio * 100).toFixed(0)}% of its ${formatSize(capacity.max)} budget. ` +
      `Warming new images would evict images it just warmed, so they are being skipped. ` +
      `Raise POSTER_CACHE_MAX_SIZE or disable image classes you do not need.`
    );
  }

  for (const target of targets) {
    const key = keyOf(target);
    // Counted once per image, not once per offer: the same poster is offered again
    // for every catalog it appears in, and counting those made the dashboard report
    // several times more images than the cache holds. The queueing below is
    // deliberately left to run on every offer so a dropped image can still be retried.
    const firstSight = !counted.has(key);
    if (firstSight) {
      counted.add(key);
      stats.offered += 1;
    }

    const freshClass = target.http ? target.checkClass : target.imageClass;
    const freshKey = target.http ? target.checkKey : target.url;
    if (freshClass && freshKey && store.isCachedFresh(freshClass, freshKey)) {
      if (firstSight) stats.skipped += 1;
      continue;
    }
    const inBulk = BULK_CLASSES.has(target.imageClass);
    if (inBulk ? bulkFull : full) {
      stats.atCapacity += 1;
      continue;
    }
    const lane = inBulk ? bulk : main;
    if (lane.size >= max) {
      stats.dropped += 1;
      continue;
    }

    if (pending.has(key)) continue;
    pending.add(key);
    lane.push(target);
    stats.queued += 1;
  }

  if (depth() > 0) {
    notePeak();
    cancelIdleReport();
    startLagProbe();
    pump();
  }
}

async function runOne(target: WarmTarget): Promise<void> {
  if (target.http) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const { fetch: undiciFetch } = require('undici');
      const response = await undiciFetch(target.http, {
        method: 'GET',
        signal: controller.signal,
        dispatcher: require('../../utils/httpClient').directDispatcher,
      });
      await response.arrayBuffer();
      stats.rendered += 1;
      classStats(target.imageClass).rendered += 1;
    } finally {
      clearTimeout(timer);
    }
    return;
  }

  const result = await store.getOrFetch(target.imageClass, target.url, (validators) => fetchImage(target.url, { validators }), { awaitRefresh: true });
  if (result.status === 'HIT') {
    stats.alreadyFresh += 1;
    classStats(target.imageClass).alreadyFresh += 1;
  } else {
    stats.warmed += 1;
    classStats(target.imageClass).warmed += 1;
  }
}

function pump(): void {
  const max = getWarmConcurrencyMax();
  const limit = Math.min(Math.max(desired, getWarmConcurrencyMin()), max);

  while (active < limit && depth() > 0) {
    const target = main.take() ?? bulk.take();
    if (!target) break;
    active += 1;
    draining = true;
    notePeak();

    runOne(target)
      .catch((error: any) => {
        stats.failed += 1;
        const reason = classifyFailure(error);
        failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
        const perClass = classStats(target.imageClass);
        perClass.failed += 1;
        perClass.failures.set(reason, (perClass.failures.get(reason) || 0) + 1);
      })
      .finally(() => {
        pending.delete(keyOf(target));
        active -= 1;
        persist(false);
        if (depth() > 0) {
          pump();
        } else if (active === 0 && draining) {
          scheduleIdleReport();
        }
      });
  }
}

export function getStats(): Stats & {
  depth: number; concurrency: number; lagMs: number;
  failures: Record<string, number>; byClass: Record<string, ClassSummary>;
  lastRun: WarmSummary | null;
} {
  return {
    ...stats, depth: depth(), concurrency: active, lagMs: observedLag,
    failures: Object.fromEntries(failureReasons), byClass: snapshotByClass(), lastRun,
  };
}

/**
 * Zeroes the counters without touching the queue, so a run that starts while the
 * previous one is still draining does not throw away its outstanding work. Without
 * this the counters ran for the life of the process and read as a single run.
 */
export function resetStats(): void {
  counted.clear();
  failureReasons.clear();
  byClass.clear();
  capacityWarned = false;
  lastReported = -1;
  for (const key of Object.keys(stats) as (keyof Stats)[]) stats[key] = 0;
}

export function reset(): void {
  main.clear();
  bulk.clear();
  pending.clear();
  resetStats();
}

export async function drain(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ((depth() > 0 || active > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return depth() === 0 && active === 0;
}
