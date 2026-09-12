import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import redis from '../redisClient';
import { decodeJellyfinId, encodeJellyfinId, normaliseJellyfinId, parseStremioId, stremioIdFor } from './ids';
import { mapWithConcurrency } from '../../utils/concurrency';
import { fetchMeta } from './items';
import { upsertPlaystateEverywhere } from './aliases';

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
// arriving without a position can still say where it got to. Kept in Redis so
// a session survives this process restarting under it: otherwise the resume
// after a restart reads as the first event and is swallowed as no transition.
const positions = new LRUCache<string, SessionPosition>({
  max: envInt('JELLYFIN_SESSION_CACHE_MAX', 5000, 1),
  ttl: envInt('JELLYFIN_SESSION_CACHE_TTL', 12 * 60 * 60, 60) * 1000,
});

function sessionTtlSeconds(): number {
  return envInt('JELLYFIN_SESSION_CACHE_TTL', 12 * 60 * 60, 60);
}

async function getPosition(key: string): Promise<SessionPosition | undefined> {
  const local = positions.get(key);
  if (local) return local;
  if (!redis) return undefined;
  try {
    const stored = await redis.get(`jf:pos:${key}`);
    if (!stored) return undefined;
    const parsed = JSON.parse(stored) as SessionPosition;
    positions.set(key, parsed);
    return parsed;
  } catch {
    return undefined;
  }
}

function setPosition(key: string, value: SessionPosition): void {
  positions.set(key, value);
  if (redis) redis.set(`jf:pos:${key}`, JSON.stringify(value), 'EX', sessionTtlSeconds()).catch(() => undefined);
}

function deletePosition(key: string): void {
  positions.delete(key);
  if (redis) redis.del(`jf:pos:${key}`).catch(() => undefined);
}

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

async function recordPlaystate(
  userUUID: string,
  profile: string,
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number,
  played: boolean | null
): Promise<void> {
  const database: any = require('../database');
  const videoId = session.videoId;
  const runtimeMs = session.runtimeMs ?? 0;

  try {
    if (event === 'unplayed') {
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, played: false, lastPlayedAt: null }, profile);
      return;
    }
    if (event === 'played') {
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, runtimeMs, played: true, lastPlayedAt: Date.now() }, profile);
      return;
    }
    if (event === 'stop' && played === true) {
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, runtimeMs, played: true, lastPlayedAt: Date.now() }, profile);
      return;
    }
    await upsertPlaystateEverywhere(userUUID, videoId, { positionMs, runtimeMs, lastPlayedAt: Date.now() }, profile);
  } catch (error: any) {
    logger.warn(`Playstate write failed for ${videoId}: ${error?.message || error}`);
  }
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

  const { profileKey, readsTrackers } = require('./profiles');
  const profile = profileKey(config);
  const key = `${userUUID}:${profile}:${itemId}`;
  const known = await getPosition(key);
  const reported = ticksToMs(body?.PositionTicks ?? body?.positionTicks);
  const positionMs = reported ?? known?.positionMs ?? 0;

  // A client re-sends Playing while it runs; reopening an already-playing
  // session is noise. A resume comes through the pause edge instead.
  if (event === 'start' && known && known.paused === false) {
    setPosition(key, { positionMs, at: Date.now(), paused: false });
    return;
  }

  let played: boolean | null = null;
  if (event === 'played') played = true;
  if (event === 'stop') {
    played =
      session.runtimeMs && session.runtimeMs > 0
        ? (positionMs / session.runtimeMs) * 100 >= watchedAtPercent()
        : false;
    deletePosition(key);
  } else {
    // Recorded as playing, not unknown: a following tick reporting the same
    // state would otherwise read as a change and reopen the session.
    setPosition(key, { positionMs, at: Date.now(), paused: event === 'pause' });
  }

  // The table is written before any tracker is told, so a read never waits on one.
  await recordPlaystate(userUUID, profile, session, event, positionMs, played);

  // A separate viewer's plays are not the account's history.
  if (!readsTrackers(config)) return;

  // A pause at zero is what a collapsed position looks like, and a real one says
  // nothing a tracker can use, so it is remembered without writing a resume
  // point every service would then show as continue-watching from the start.
  if (event === 'pause' && positionMs <= 0) {
    logger.debug(`Not reporting a pause at zero for ${session.videoId}`);
    return;
  }

  await tellTrackers(userUUID, config, session, event, positionMs, played);
}

async function tellTrackers(
  userUUID: string,
  config: any,
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number,
  played: boolean | null
): Promise<void> {
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
  const { invalidateWatched } = require('./watched');
  invalidateResume(userUUID);

  // Only a finished stop drops the tracker snapshot: the tracker may now know
  // more than the table, such as a show's next episode.
  if (event === 'stop' && played === true) {
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
// A client marks a season or a whole series with one call on that item's id;
// the mark applies to each aired episode in it. The table is written for all
// of them before this returns, since the client reads the item back straight
// after and a half-marked season shows no tick; the trackers are told after.
async function markEach(req: any, body: any, event: 'played' | 'unplayed'): Promise<void> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  if (!userUUID || !itemId) return;

  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config?.playbackReporting) return;

  const { profileKey, readsTrackers } = require('./profiles');
  const profile = profileKey(config);
  const played = event === 'played';

  const sessions = (await mapWithConcurrency(await markedItemIds(userUUID, itemId), 8, async (id: string) => {
    const session = await resolveSession(userUUID, id);
    if (!session) {
      logger.debug(`No playable session for ${id}`);
      return null;
    }
    deletePosition(`${userUUID}:${profile}:${id}`);
    await recordPlaystate(userUUID, profile, session, event, 0, played);
    return session;
  })).filter((s): s is ResolvedSession => s !== null);

  if (!readsTrackers(config)) return;
  mapWithConcurrency(sessions, 3, (session: ResolvedSession) => tellTrackers(userUUID, config, session, event, 0, played))
    .catch((error: any) => logger.debug(`Mark report failed for ${itemId}: ${error?.message || error}`));
}

/** The item itself, or each aired episode of the season or series it names. */
async function markedItemIds(userUUID: string, itemId: string): Promise<string[]> {
  const descriptor = await decodeJellyfinId(itemId);
  if (!descriptor || (descriptor.k !== 'season' && descriptor.k !== 'series')) return [itemId];

  const meta = await fetchMeta(userUUID, 'series', descriptor.i);
  const videos: any[] = Array.isArray(meta?.videos) ? meta.videos : [];
  const now = Date.now();
  const ids: string[] = [];
  for (const video of videos) {
    if (descriptor.k === 'season' ? video.season !== descriptor.s : video.season === 0) continue;
    const aired = Date.parse(video.released || '');
    if (Number.isFinite(aired) && aired > now) continue;
    const parsed = parseStremioId(String(video.id ?? ''));
    if (parsed) ids.push(encodeJellyfinId({ k: 'episode', t: descriptor.t, i: parsed.base, s: parsed.season, e: parsed.episode as number }));
  }
  return ids;
}

export async function recordPlayed(req: any, body: any): Promise<void> {
  await markEach(req, body, 'played');
}

export async function recordUnplayed(req: any, body: any): Promise<void> {
  await markEach(req, body, 'unplayed');
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

  const { loadConfig } = require('./context');
  const { profileKey } = require('./profiles');
  const key = `${userUUID}:${profileKey(await loadConfig(req))}:${itemId}`;
  const previous = await getPosition(key);
  const paused = body?.IsPaused === true || body?.isPaused === true;

  // A client keeps reporting every few seconds while paused, so only the change
  // is worth acting on: pausing stores a resume point, resuming reopens the
  // session at the position it left off. The state is left for report() to
  // write, since it decides against what the session was, not what it is.
  const changed = previous !== undefined && previous.paused !== paused;
  const startsPaused = previous === undefined && paused;
  if (!changed && !startsPaused) {
    setPosition(key, { positionMs, at: Date.now(), paused });
    return;
  }

  await report(req, body, paused ? 'pause' : 'start');
}

/**
 * The one-call edit of an item's state a client offers next to mark-watched: a
 * played flag, or a resume position, which cleared is what drops the item from
 * continue watching. Answers the state the item is now in.
 */
export async function recordUserData(req: any, body: any): Promise<{ played: boolean; positionMs: number } | null> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  if (!userUUID || !itemId) return null;

  const played = body?.Played ?? body?.played;
  if (played === true || played === false) {
    await markEach(req, { ItemId: itemId }, played ? 'played' : 'unplayed');
    return { played, positionMs: 0 };
  }

  const positionMs = ticksToMs(body?.PlaybackPositionTicks ?? body?.playbackPositionTicks);
  if (positionMs === null) return null;

  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config?.playbackReporting) return null;

  const session = await resolveSession(userUUID, itemId);
  if (!session) return null;

  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  deletePosition(`${userUUID}:${profile}:${itemId}`);
  await upsertPlaystateEverywhere(userUUID, session.videoId, { positionMs, runtimeMs: session.runtimeMs ?? 0 }, profile);

  const { invalidateResume } = require('./resume');
  invalidateResume(userUUID);

  // Cleared here means cleared on the trackers too, or their copy would come
  // back through the shelf on any device reading them directly.
  const { readsTrackers } = require('./profiles');
  if (positionMs === 0 && readsTrackers(config)) {
    const { parseMediaId, clearResumePoint } = require('../subtitleHandler');
    const parsed = parseMediaId(session.videoId);
    if (parsed) {
      clearResumePoint(parsed, config).catch((error: any) =>
        logger.debug(`Clearing the resume point on trackers failed for ${session.videoId}: ${error?.message || error}`)
      );
    }
  }

  const database: any = require('../database');
  const row = await database.getPlaystate(userUUID, session.videoId, profile);
  return { played: Boolean(row?.played), positionMs };
}
