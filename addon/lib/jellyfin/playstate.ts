import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { decodeJellyfinId, normaliseJellyfinId, stremioIdFor } from './ids';
import { fetchMeta } from './items';

const logger = consola.withTag('JellyfinPlaystate');

const TICKS_PER_MS = 10000;

function watchedAtPercent(): number {
  return envInt('JELLYFIN_PLAYED_THRESHOLD', 90, 1);
}

interface SessionPosition {
  positionMs: number;
  at: number;
  /** Last reported pause state, so only the change is acted on. */
  paused?: boolean;
}

// A client that dies never sends a stop, so the last tick is kept and a stop
// arriving without a position can still say where it got to.
const positions = new LRUCache<string, SessionPosition>({
  max: envInt('JELLYFIN_SESSION_CACHE_MAX', 5000, 1),
  ttl: envInt('JELLYFIN_SESSION_CACHE_TTL', 12 * 60 * 60, 60) * 1000,
});

function ticksToMs(value: any): number | null {
  const ticks = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(ticks) ? Math.round(ticks / TICKS_PER_MS) : null;
}

function bodyItemId(req: any, body: any): string | null {
  const raw = body?.ItemId ?? body?.itemId ?? req.params?.itemId;
  return raw ? normaliseJellyfinId(String(raw)) : null;
}

export interface ResolvedSession {
  stremioType: 'movie' | 'series';
  videoId: string;
  descriptor: any;
  runtimeMs: number | null;
}

// The runtime is not in any playstate payload, so it comes from the meta.
async function resolveSession(userUUID: string, itemId: string): Promise<ResolvedSession | null> {
  const descriptor = await decodeJellyfinId(itemId);
  if (!descriptor) return null;
  if (descriptor.k !== 'movie' && descriptor.k !== 'episode') return null;

  const videoId = stremioIdFor(descriptor);
  if (!videoId) return null;

  const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
  const meta = await fetchMeta(userUUID, stremioType, descriptor.i);

  let runtimeMs: number | null = null;
  if (meta) {
    let runtime = meta.runtime;
    if (descriptor.k === 'episode' && Array.isArray(meta.videos)) {
      const video = meta.videos.find((v: any) => String(v?.id) === videoId);
      if (video?.runtime) runtime = video.runtime;
    }
    runtimeMs = parseRuntimeMs(runtime);
  }

  return { stremioType, videoId, descriptor, runtimeMs };
}

function parseRuntimeMs(runtime: any): number | null {
  if (typeof runtime !== 'string') return null;
  const hours = /(\d+)\s*h/.exec(runtime);
  const minutes = /(\d+)\s*min/.exec(runtime);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return total > 0 ? total * 60 * 1000 : null;
}

function reportFor(
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number | null,
  played: boolean | null
): any {
  const d = session.descriptor;
  return {
    // Keyed on position, not a clock bucket: pausing and resuming inside a
    // minute are real transitions a time bucket would collapse into one.
    // A mark carries no position, so keying on it alone made every later mark of
    // the same title read as the first one being retried and it was dropped.
    // Nothing retries on this path, a client calls once, so each mark is its own
    // event and repeats are caught by the decision it carries instead.
    id:
      event === 'played' || event === 'unplayed'
        ? `jellyfin|${session.videoId}|${event}|${Date.now()}`
        : `jellyfin|${session.videoId}|${event}|${positionMs ?? 0}`,
    event,
    at: Math.floor(Date.now() / 1000),
    metaId: d.i,
    videoId: session.videoId,
    positionMs: positionMs ?? 0,
    durationMs: session.runtimeMs ?? 0,
    played,
    season: d.k === 'episode' ? d.s : null,
    episode: d.k === 'episode' ? d.e : null,
    ids: {},
  };
}

async function report(
  req: any,
  body: any,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed'
): Promise<void> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  if (!userUUID || !itemId) return;

  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config?.playbackReporting) return;

  const session = await resolveSession(userUUID, itemId);
  if (!session) {
    logger.debug(`No playable session for ${itemId}`);
    return;
  }

  const key = `${userUUID}:${itemId}`;
  const known = positions.get(key);
  const reported = ticksToMs(body?.PositionTicks ?? body?.positionTicks);
  const positionMs = reported ?? known?.positionMs ?? 0;

  // A client re-sends Playing while it runs; reopening an already-playing
  // session is noise. A resume comes through the pause edge instead.
  if (event === 'start' && known && known.paused === false) {
    positions.set(key, { positionMs, at: Date.now(), paused: false });
    return;
  }

  let played: boolean | null = null;
  if (event === 'played') played = true;
  if (event === 'stop') {
    played =
      session.runtimeMs && session.runtimeMs > 0
        ? (positionMs / session.runtimeMs) * 100 >= watchedAtPercent()
        : false;
    positions.delete(key);
  } else {
    // Recorded as playing, not unknown: a following tick reporting the same
    // state would otherwise read as a change and reopen the session.
    positions.set(key, { positionMs, at: Date.now(), paused: event === 'pause' });
  }

  // A pause at zero is what a collapsed position looks like, and a real one says
  // nothing a tracker can use, so it is remembered without writing a resume
  // point every service would then show as continue-watching from the start.
  if (event === 'pause' && positionMs <= 0) {
    logger.debug(`Not reporting a pause at zero for ${session.videoId}`);
    return;
  }

  const { handlePlaybackReport } = require('../playbackHandler');
  await handlePlaybackReport(
    session.stremioType,
    session.videoId,
    reportFor(session, event, positionMs, played),
    config,
    userUUID
  );

  // The trackers now hold state this server just changed, so the snapshots the
  // resume shelf and the watched ticks read from are dropped rather than left
  // serving what they cached before the event.
  const { invalidateResume } = require('./resume');
  const { invalidateWatched, noteWatched } = require('./watched');
  invalidateResume(userUUID);

  // Recorded rather than refetched: dropping the snapshot would send us back to
  // a tracker that has not published the write yet, and the answer would be the
  // state from before. The tracker becomes the truth again on its own cadence.
  const marksWatched = event === 'played' || (event === 'stop' && played === true);
  if (marksWatched || event === 'unplayed') {
    noteWatched(session.videoId, event !== 'unplayed');
  } else if (event !== 'pause' && event !== 'start') {
    await invalidateWatched(config).catch(() => undefined);
  }
}

export async function recordPlaying(req: any, body: any): Promise<void> {
  await report(req, body, 'start');
}

export async function recordStopped(req: any, body: any): Promise<void> {
  await report(req, body, 'stop');
}

/** The mark-watched a client offers on an item, taken without it being played. */
export async function recordPlayed(req: any, body: any): Promise<void> {
  await report(req, body, 'played');
}

export async function recordUnplayed(req: any, body: any): Promise<void> {
  await report(req, body, 'unplayed');
}

/**
 * Progress is not forwarded anywhere: no tracker has an endpoint for it. It is
 * only remembered, so a stop that arrives without a position still has one.
 */
export async function recordProgress(req: any, body: any): Promise<void> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  const positionMs = ticksToMs(body?.PositionTicks ?? body?.positionTicks);
  if (!userUUID || !itemId || positionMs === null) return;

  const key = `${userUUID}:${itemId}`;
  const previous = positions.get(key);
  const paused = body?.IsPaused === true || body?.isPaused === true;

  // A client keeps reporting every few seconds while paused, so only the change
  // is worth acting on: pausing stores a resume point, resuming reopens the
  // session at the position it left off. The state is left for report() to
  // write, since it decides against what the session was, not what it is.
  const changed = previous !== undefined && previous.paused !== paused;
  const startsPaused = previous === undefined && paused;
  if (!changed && !startsPaused) {
    positions.set(key, { positionMs, at: Date.now(), paused });
    return;
  }

  await report(req, body, paused ? 'pause' : 'start');
}
