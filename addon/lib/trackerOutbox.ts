import consola from 'consola';
import { createHash } from 'crypto';
import { accountOwner, credentialOf, trackerConfig } from './accounts';
import { runInViewerScope } from './jellyfin/viewer';
import { envInt } from '../utils/envNumber';
import { recordingTrackerCalls, type TrackerCall } from '../utils/trackerCalls';
import type { WatchTrackingService } from './watchTracking';

/**
 * Writes to the trackers, kept in the database until each one lands. A tracker
 * account is a lane: its writes go one at a time and in order, which is what
 * Simkl's per-user write lock and one-POST-a-second limit ask for, while other
 * accounts are written alongside. A write that fails for want of an answer is
 * tried again later; one the tracker refuses is dropped.
 */

const logger = consola.withTag('TrackerOutbox');
const database: any = require('./database');

export type OutboxOp = 'scrobble' | 'credit' | 'unwatch' | 'redate' | 'clearResume' | 'anime' | 'episodes' | 'dropped' | 'watchlist' | 'rate';

export interface OutboxJob {
  service: WatchTrackingService;
  op: OutboxOp;
  /** The title the write is about. A title's writes on one account are sent in the order they were made. */
  item: string;
  /** A waiting write with the same key is replaced by this one. */
  coalesce?: string | null;
  payload: any;
  /** Sent no later than this many seconds from now, or not at all. */
  within?: number;
}

type Executor = (service: WatchTrackingService, payload: any, config: any, userUUID: string) => Promise<unknown>;

const executors: Record<OutboxOp, Executor> = {
  scrobble: (service, p, config, userUUID) => require('./playbackHandler').deliverScrobble(service, p, config, userUUID),
  credit: (service, p, config) => require('./playbackHandler').deliverCredit(service, p, config),
  unwatch: (service, p, config) => require('./playbackHandler').deliverUnwatch(service, p, config),
  redate: (service, p, config) => require('./playbackHandler').deliverWatchDate(service, p, config),
  clearResume: (service, p, config) => require('./playbackHandler').deliverClearResume(service, p, config),
  anime: (service, p, config, userUUID) => require('./playbackHandler').deliverAnime(service, p, config, userUUID),
  episodes: (service, p, config) => require('./subtitleHandler').markEpisodes(p.videos, config, p.method, p.scope, service),
  dropped: (service, p, config) => require('./jellyfin/dropped').writeDropped(config, p.ids, p.dropped, service),
  watchlist: (service, p, config, userUUID) => require('./jellyfin/watchlistSources').writeWatchlist(config, userUUID, p.ids, p.kind, p.listed, service),
  rate: (service, p, config, userUUID) => require('./jellyfin/ratings').writeRating(config, p, service, userUUID),
};

// Writes that change what the trackers report as watched, rather than only where playback stands.
const CHANGES_WATCHED = new Set<OutboxOp>(['scrobble', 'credit', 'unwatch', 'redate', 'episodes', 'dropped', 'anime']);
const CHANGES_RESUME = new Set<OutboxOp>(['scrobble', 'credit', 'unwatch', 'clearResume', 'episodes']);
const CHANGES_UPCOMING = new Set<OutboxOp>(['watchlist']);

const LEASE_MS = 5 * 60 * 1000;
const SCAN_LIMIT = 1000;

const concurrency = (): number => envInt('TRACKER_OUTBOX_CONCURRENCY', 6, 1);
const maxAgeMs = (): number => envInt('TRACKER_OUTBOX_MAX_AGE_HOURS', 72, 1) * 60 * 60 * 1000;

/** How long a "now watching" stays worth sending. */
export const startWindowSeconds = (): number => envInt('TRACKER_OUTBOX_START_WINDOW', 600, 30);

export function hasCredential(config: any, service: WatchTrackingService): boolean {
  return Boolean(credentialOf(config, service));
}

function laneKey(service: WatchTrackingService, credential: string): string {
  return `${service}:${createHash('sha256').update(String(credential)).digest('hex').substring(0, 24)}`;
}

function laneFor(config: any, service: WatchTrackingService): string | null {
  const credential = credentialOf(config, service);
  return credential ? laneKey(service, credential) : null;
}

export interface PendingWatch {
  videoId: string;
  kind: 'movie' | 'episode';
  metaId: string;
  played: boolean;
  at: number;
}

/**
 * Watches and unwatches still waiting for this account, the last word per title.
 * What is read back from the tracker is built on top of them, or a write waiting
 * out a retry would vanish from the ticks until it lands.
 */
export async function pendingWatches(service: WatchTrackingService, credential: string): Promise<PendingWatch[]> {
  const { parseStremioId } = require('./jellyfin/ids');
  const out = new Map<string, PendingWatch>();
  const note = (videoId: string, played: boolean, at: number) => {
    const parsed = parseStremioId(String(videoId));
    if (!parsed) return;
    const kind = parsed.episode !== null && parsed.episode !== undefined ? 'episode' : 'movie';
    out.set(videoId, { videoId, kind, metaId: kind === 'episode' ? parsed.base : videoId, played, at });
  };
  for (const row of await database.listTrackerOutboxLane(laneKey(service, credential))) {
    let p: any;
    try {
      p = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (row.op === 'credit') note(p.id, true, row.created_at);
    else if (row.op === 'unwatch') note(p.id, false, row.created_at);
    else if (row.op === 'scrobble' && p.report?.event === 'stop' && p.report?.played === true) note(p.id, true, row.created_at);
    else if (row.op === 'episodes') for (const video of p.videos ?? []) note(video, p.method === 'addToHistory', row.created_at);
    else if (row.op === 'anime') note(p.id, true, row.created_at);
  }
  return [...out.values()];
}

/**
 * Queues the writes and returns once they are stored. Without a stored
 * configuration to deliver them with later, or when the database refuses them,
 * they are sent now instead, as they always were.
 */
export async function enqueueTrackerWrites(userUUID: string | undefined, config: any, jobs: OutboxJob[]): Promise<void> {
  const rows = jobs
    .map((job) => ({ job, lane: laneFor(config, job.service) }))
    .filter((entry): entry is { job: OutboxJob; lane: string } => entry.lane !== null);
  if (!rows.length) {
    if (userUUID) settle(userUUID, config, ['clearResume']);
    return;
  }

  if (userUUID) {
    try {
      const now = Date.now();
      await database.enqueueTrackerOutbox(rows.map(({ job, lane }) => ({
        lane,
        userUUID,
        profile: accountOwner(config),
        service: job.service,
        op: job.op,
        item: job.item,
        coalesce: job.coalesce ?? null,
        payload: job.payload,
        expiresAt: now + (job.within ? job.within * 1000 : maxAgeMs()),
      })));
      kick();
      return;
    } catch (error: any) {
      logger.warn(`Could not queue ${rows.length} tracker write(s), sending them now: ${error?.message || error}`);
    }
  }

  for (const { job } of rows) {
    await executors[job.op](job.service, job.payload, trackerConfig(config, job.service), userUUID ?? '').catch((error: any) =>
      logger.error(`${job.service} ${job.op} failed: ${error?.message || error}`)
    );
  }
  if (userUUID) settle(userUUID, config, jobs.map((job) => job.op));
}

// --- Delivery -----------------------------------------------------------------------

const active = new Set<string>();
let pumping = false;
let again = false;
let wakeTimer: NodeJS.Timeout | null = null;
let wakeAt = Infinity;
let started = false;

export function startTrackerOutbox(): void {
  if (started) return;
  started = true;
  kick();
}

function kick(): void {
  started = true;
  // A fresh, empty scope: the pump must not inherit whichever request's viewer queued the write.
  setImmediate(() => { runInViewerScope(false, () => pump()).catch((error: any) => logger.warn(`Outbox pass failed: ${error?.message || error}`)); });
}

function wakeBy(at: number): void {
  if (!Number.isFinite(at) || at >= wakeAt) return;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeAt = at;
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    wakeAt = Infinity;
    kick();
  }, Math.max(0, at - Date.now()) + 50);
  wakeTimer.unref?.();
}

async function pump(): Promise<void> {
  if (pumping) {
    again = true;
    return;
  }
  pumping = true;
  try {
    do {
      again = false;
      const now = Date.now();
      const rows: any[] = await database.listTrackerOutbox(SCAN_LIMIT);
      const busyLanes = new Set<string>(active);
      const waiting = new Set<string>();
      const picks: any[] = [];
      let wake = Infinity;

      for (const row of rows) {
        const title = `${row.lane}|${row.item_key}`;
        if (row.claimed_until > now) {
          // Being sent, here or by another process: the lane waits for it.
          busyLanes.add(row.lane);
          wake = Math.min(wake, row.claimed_until);
          continue;
        }
        if (waiting.has(title) || busyLanes.has(row.lane)) continue;
        if (row.next_at > now) {
          // A later write about the same title must not overtake this one.
          waiting.add(title);
          wake = Math.min(wake, row.next_at);
          continue;
        }
        picks.push(row);
        busyLanes.add(row.lane);
      }

      const slots = concurrency() - active.size;
      for (const row of picks.slice(0, Math.max(0, slots))) {
        if (!(await database.claimTrackerOutbox(row.id, Date.now() + LEASE_MS))) continue;
        active.add(row.lane);
        deliver(row)
          .catch((error: any) => logger.warn(`Delivering ${row.service} ${row.op} failed: ${error?.message || error}`))
          .finally(() => {
            active.delete(row.lane);
            kick();
          });
      }
      wakeBy(wake);
    } while (again);
  } finally {
    pumping = false;
  }
}

type Outcome = { kind: 'done' } | { kind: 'retry'; at?: number; reason: string } | { kind: 'drop'; reason: string; status?: number };

/** Judged by the last answer: a lookup that failed before a fallback that worked is not a failure. */
function judge(calls: TrackerCall[], error: any): Outcome {
  const last = calls[calls.length - 1];
  if (!last) return error ? { kind: 'drop', reason: String(error?.message || error) } : { kind: 'done' };
  const { status, body } = last;
  if ((status >= 200 && status < 300) || status === 409) return { kind: 'done' };
  // Simkl's write lock clears once the write holding it finishes.
  if (status === 400 && last.host === 'api.simkl.com' && /rate_limit/i.test(body ?? '')) {
    return { kind: 'retry', at: Date.now() + 5000 + Math.random() * 5000, reason: 'Simkl write lock' };
  }
  if (status === 0 || status === 408 || status === 429 || status >= 500) {
    return { kind: 'retry', at: last.retryAt, reason: status === 0 ? `${last.host} did not answer` : `${last.host} answered ${status}` };
  }
  return { kind: 'drop', status, reason: `${last.host} answered ${status}${body ? `: ${body.slice(0, 120)}` : ''}` };
}

function backoffMs(attempts: number): number {
  const base = Math.min(30_000 * Math.pow(2, Math.max(0, attempts - 1)), 60 * 60 * 1000);
  return base + Math.random() * base * 0.2;
}

async function deliver(row: any): Promise<void> {
  const label = `${row.service} ${row.op} for ${row.item_key}`;
  if (row.expires_at <= Date.now()) {
    logger.debug(`Dropping ${label}: too late to send`);
    await database.deleteTrackerOutbox(row.id);
    return;
  }

  let config: any;
  try {
    const stored = await require('./configApi').loadSharedConfig(row.user_uuid);
    const { scopeConfigToProfile } = require('./jellyfin/profiles');
    config = { ...scopeConfigToProfile(stored, row.user_uuid, row.profile || null), userUUID: row.user_uuid };
  } catch (error: any) {
    if (error?.code === 'CONFIG_NOT_FOUND') {
      await database.deleteTrackerOutbox(row.id);
      return;
    }
    await database.retryTrackerOutbox(row.id, row.attempts + 1, Date.now() + backoffMs(row.attempts + 1), `configuration: ${error?.message || error}`);
    return;
  }

  if (row.profile && (accountOwner(config) !== row.profile || !credentialOf(config, row.service))) {
    await database.deleteTrackerOutbox(row.id);
    logger.warn(`Dropping ${label}: user ${row.profile} no longer holds a ${row.service} account`);
    return;
  }

  const executor = executors[row.op as OutboxOp];
  if (!executor) {
    await database.deleteTrackerOutbox(row.id);
    return;
  }

  const payload = JSON.parse(row.payload);
  const { calls, error } = await recordingTrackerCalls(() => executor(row.service, payload, trackerConfig(config, row.service), row.user_uuid));
  const outcome = judge(calls, error);

  if (outcome.kind === 'done') {
    await database.deleteTrackerOutbox(row.id);
    if (row.attempts > 0) logger.info(`Sent ${label} after ${row.attempts + 1} attempts`);
    settle(row.user_uuid, config, [row.op]);
    return;
  }
  if (outcome.kind === 'drop') {
    await database.deleteTrackerOutbox(row.id);
    // Nothing to clear or remove is the outcome those writes wanted.
    if (outcome.status === 404 && (row.op === 'clearResume' || row.op === 'unwatch')) logger.debug(`Nothing to change for ${label}: ${outcome.reason}`);
    else logger.warn(`Gave up on ${label}: ${outcome.reason}`);
    return;
  }

  const attempts = row.attempts + 1;
  const nextAt = Math.max(outcome.at ?? 0, Date.now() + (outcome.reason === 'Simkl write lock' ? 0 : backoffMs(attempts)));
  if (nextAt >= row.expires_at) {
    await database.deleteTrackerOutbox(row.id);
    logger.warn(`Gave up on ${label} after ${attempts} attempts: ${outcome.reason}`);
    return;
  }
  await database.retryTrackerOutbox(row.id, attempts, nextAt, outcome.reason);
  logger.debug(`Will retry ${label} at ${new Date(nextAt).toISOString()}: ${outcome.reason}`);
}

// --- After a write lands ------------------------------------------------------------

const settling = new Map<string, { timer: NodeJS.Timeout; watched: boolean; resume: boolean; upcoming: boolean; config: any }>();

/** What the trackers now hold changed, so the shelves read from them are read again; a burst of writes does it once. */
function settle(userUUID: string, config: any, ops: OutboxOp[]): void {
  const watched = ops.some((op) => CHANGES_WATCHED.has(op));
  const resume = ops.some((op) => CHANGES_RESUME.has(op));
  const upcoming = ops.some((op) => CHANGES_UPCOMING.has(op));
  if (!watched && !resume && !upcoming) return;
  const key = `${userUUID}:${accountOwner(config)}`;
  const pending = settling.get(key);
  if (pending) clearTimeout(pending.timer);
  const entry = {
    watched: watched || Boolean(pending?.watched),
    resume: resume || Boolean(pending?.resume),
    upcoming: upcoming || Boolean(pending?.upcoming),
    config,
    timer: setTimeout(() => {
      settling.delete(key);
      if (entry.resume) require('./jellyfin/resume').invalidateResume(userUUID);
      if (entry.watched) require('./jellyfin/watched').invalidateWatched(entry.config).catch(() => undefined);
      if (entry.upcoming) {
        require('./jellyfin/watched').forgetUpcomingFollowed(entry.config)
          .then(() => require('./jellyfin/resume').invalidateDatedShelves(userUUID))
          .catch(() => undefined);
      }
    }, 1500),
  };
  entry.timer.unref?.();
  settling.set(key, entry);
}
