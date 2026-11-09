import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import redis from '../redisClient';
import { dashedGuid, decodeJellyfinId, encodeJellyfinId, normaliseJellyfinId, parseStremioId, stremioIdFor } from './ids';
import { mapWithConcurrency } from '../../utils/concurrency';
import { fetchMeta } from './items';
import { upsertPlaystateEverywhere } from './aliases';
import { PLAY_SOURCES, type PlaySourceId } from '../playSources';
import type { Descriptor } from './idsCodec';
import { playCountOf } from './dto';

const logger = consola.withTag('JellyfinPlaystate');

const TICKS_PER_MS = 10000;

const playedThresholds = new LRUCache<string, { percent: number | null }>({
  max: 5000,
  ttl: envInt('JELLYFIN_USER_SETTINGS_CACHE_MS', 60000, 0) || 1,
});

/** A profile's settings were saved, so they are read again. */
export function forgetUserSettings(userUUID: string): void {
  for (const key of playedThresholds.keys()) if (key.startsWith(`${userUUID}:`)) playedThresholds.delete(key);
}

const USER_CONFIGURATION_ID = 'user-configuration';

export function serverPlayedThreshold(): number {
  return envInt('JELLYFIN_PLAYED_THRESHOLD', 80, 1);
}

export function validPlayedThreshold(value: unknown): number | null {
  const percent = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(percent) && percent >= 50 && percent <= 100 ? percent : null;
}

export async function storedPlayedThreshold(userUUID: string, profileId: string | null): Promise<number | null> {
  const key = `${userUUID}:${profileId ?? ''}`;
  let held = playedThresholds.get(key);
  if (!held) {
    try {
      const database = require('../database');
      const { profileById } = require('./profiles');
      const config = await database.getUserConfig(userUUID);
      const profile = profileById(config, userUUID, profileId);
      const stored = await database.getPreferences(userUUID, profile?.id ?? '', USER_CONFIGURATION_ID, '');
      held = { percent: validPlayedThreshold(stored?.PlayedThresholdPercent) };
    } catch {
      held = { percent: null };
    }
    playedThresholds.set(key, held);
  }
  return held.percent;
}

export async function playedThresholdFor(userUUID: string, profileId: string | null): Promise<number> {
  return (await storedPlayedThreshold(userUUID, profileId)) ?? serverPlayedThreshold();
}

export async function savePlayedThreshold(userUUID: string, profileId: string | null, percent: number | null): Promise<void> {
  const database = require('../database');
  const stored = (await database.getPreferences(userUUID, profileId ?? '', USER_CONFIGURATION_ID, '')) || {};
  const next = { ...stored };
  if (percent === null) delete next.PlayedThresholdPercent;
  else next.PlayedThresholdPercent = percent;
  await database.savePreferences(userUUID, profileId ?? '', USER_CONFIGURATION_ID, '', next);
  forgetUserSettings(userUUID);
}

/** The share of a title played that counts as watched: the user's own setting, else the server's. */
async function watchedAtPercent(req: any): Promise<number> {
  const userUUID = req?.params?.userUUID;
  return userUUID ? playedThresholdFor(userUUID, req.jellyfin?.profileId ?? null) : serverPlayedThreshold();
}

interface SessionPosition {
  positionMs: number;
  at: number;
  writtenAt?: number;
  writtenMs?: number;
  /** Last reported pause state, so only the change is acted on. */
  paused?: boolean;
  /** The profile signed in, which may be playing into the account's shared history. */
  viewer?: string | null;
  device?: string;
  /** The app and device names the client gave, for showing the session. */
  app?: { client: string; device: string; version: string };
  playSession?: string;
  /** When progress passed the watched mark, so the stop that follows does not report it again. */
  playedAt?: number;
  /** Below the mark again since, with a resume point written. */
  rewound?: boolean;
  /** Marked watched during the play, so what the client still sends for it is ignored until its stop. */
  marked?: boolean;
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

const POSITIONS_KEY = 'jf:pos';
// Positions are kept for hours so a resume can find them, but the dashboard
// polls every ten seconds and only wants what is current. An index scored by
// last tick keeps that read proportional to live sessions, not to the day.
const POSITIONS_INDEX = 'jf:pos:live';
// The same, per configuration, so one account's read never walks every other's.
const accountIndex = (userUUID: string) => `${POSITIONS_INDEX}:${userUUID}`;

function liveWindowSeconds(): number {
  return envInt('JELLYFIN_LIVE_SESSION_WINDOW', 60 * 60, 60);
}

function liveWindowMs(): number {
  return liveWindowSeconds() * 1000;
}

function playSessionOf(body: any): string | undefined {
  const id = body?.PlaySessionId ?? body?.playSessionId;
  return typeof id === 'string' && id ? id : undefined;
}

function appOf(req: any): SessionPosition['app'] {
  const { client, device, version } = require('./context').clientInfo(req);
  return { client, device, version };
}

function sameSession(known: SessionPosition, device: string, playSession: string | undefined): boolean {
  if (known.playSession && playSession) return known.playSession === playSession;
  return (known.device ?? device) === device;
}

async function getPosition(key: string): Promise<SessionPosition | undefined> {
  const local = positions.get(key);
  if (local) return local;
  if (!redis) return undefined;
  try {
    const stored = await redis.hget(POSITIONS_KEY, key);
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
  if (!redis) return;
  const ttl = sessionTtlSeconds();
  const own = accountIndex(key.split(':')[0]);
  redis.multi()
    .hsetex(POSITIONS_KEY, 'EX', ttl, 'FIELDS', 1, key, JSON.stringify(value))
    .expire(POSITIONS_KEY, ttl, 'NX')
    .expire(POSITIONS_KEY, ttl, 'GT')
    .zadd(POSITIONS_INDEX, value.at, key)
    .expire(POSITIONS_INDEX, ttl, 'NX')
    .expire(POSITIONS_INDEX, ttl, 'GT')
    .zadd(own, value.at, key)
    .expire(own, liveWindowSeconds())
    .exec()
    .catch(() => undefined);
}

function deletePosition(key: string): void {
  positions.delete(key);
  if (redis) redis.multi().hdel(POSITIONS_KEY, key).zrem(POSITIONS_INDEX, key).zrem(accountIndex(key.split(':')[0]), key).exec().catch(() => undefined);
}

export type LiveSession = { userUUID: string; profile: string; viewer: string | null; itemId: string; positionMs: number; at: number; paused: boolean; device: string | null; app: SessionPosition['app'] | null; playSession: string | null };

/**
 * Every session the instance has heard from, newest first. Read from Redis so
 * the answer covers other processes and survives a restart; this process's own
 * entries win, being the fresher of the two.
 */
export async function liveSessions(): Promise<LiveSession[]> {
  return readLive(POSITIONS_INDEX, '');
}

/** One configuration's sessions, read from its own index. */
export async function liveSessionsFor(userUUID: string): Promise<LiveSession[]> {
  return readLive(accountIndex(userUUID), `${userUUID}:`);
}

async function readLive(index: string, prefix: string): Promise<LiveSession[]> {
  const cutoff = Date.now() - liveWindowMs();
  const rows = new Map<string, SessionPosition>();
  for (const [key, value] of positions.entries()) if (value.at >= cutoff && key.startsWith(prefix)) rows.set(key, value);

  if (redis) {
    try {
      const cap = envInt('JELLYFIN_SESSION_CACHE_MAX', 5000, 1);
      const keys: string[] = await redis.zrevrangebyscore(index, '+inf', cutoff, 'LIMIT', 0, cap);
      redis.zremrangebyscore(index, '-inf', `(${cutoff}`).catch(() => undefined);
      const wanted = keys.filter((key) => !rows.has(key));
      if (wanted.length > 0) {
        const stored: Array<string | null> = await redis.hmget(POSITIONS_KEY, ...wanted);
        wanted.forEach((key, i) => {
          const raw = stored[i];
          if (!raw) return;
          try { rows.set(key, JSON.parse(raw) as SessionPosition); } catch { /* unreadable row */ }
        });
      }
    } catch { /* fall back to what this process holds */ }
  }

  const out: LiveSession[] = [];
  for (const [key, value] of rows) {
    const [userUUID, profile, itemId] = key.split(':');
    if (!userUUID || !itemId) continue;
    out.push({ userUUID, profile: profile || '', viewer: value.viewer ?? null, itemId, positionMs: value.positionMs, at: value.at, paused: value.paused === true, device: value.device ?? null, app: value.app ?? null, playSession: value.playSession ?? null });
  }
  return out.sort((a, b) => b.at - a.at);
}

const touched = new LRUCache<string, number>({
  max: envInt('JELLYFIN_SESSION_CACHE_MAX', 5000, 1),
  ttl: envInt('JELLYFIN_SESSION_CACHE_TTL', 12 * 60 * 60, 60) * 1000,
});

/** A ping arrives every few seconds; only the first of an interval is acted on. */
export function sessionTouchDue(userUUID: string): boolean {
  const now = Date.now();
  const interval = envInt('JELLYFIN_SESSION_TOUCH_INTERVAL', 30, 1) * 1000;
  if (now - (touched.get(userUUID) ?? 0) < interval) return false;
  touched.set(userUUID, now);
  return true;
}

/** A Ping names no item, so every session open under the profile is carried forward. */
export async function touchSessions(userUUID: string, profile: string): Promise<void> {
  const now = Date.now();
  const stale = envInt('JELLYFIN_SESSION_TOUCH_INTERVAL', 30, 1) * 1000;
  const prefix = `${userUUID}:${profile}:`;

  const keys = new Set<string>();
  for (const [key] of positions.entries()) if (key.startsWith(prefix)) keys.add(key);
  if (redis) {
    try {
      const cutoff = now - liveWindowMs();
      const cap = envInt('JELLYFIN_SESSION_CACHE_MAX', 5000, 1);
      const live: string[] = await redis.zrevrangebyscore(accountIndex(userUUID), '+inf', cutoff, 'LIMIT', 0, cap);
      for (const key of live) if (key.startsWith(prefix)) keys.add(key);
    } catch { /* what this process holds still carries forward */ }
  }

  for (const key of keys) {
    const held = await getPosition(key);
    if (!held || now - held.at < stale) continue;
    setPosition(key, { ...held, at: now });
  }
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
  itemId: string;
  stremioType: 'movie' | 'series';
  videoId: string;
  descriptor: any;
  runtimeMs: number | null;
  runtimeFrom?: 'client' | 'file';
  /** The same film or episode under the ids the meta carries, written alongside so any spelling reads back. */
  aliases: string[];
}

const ANIME_VIDEO = /^(kitsu|mal|anilist|anidb):/;

const resolvedSessions = new LRUCache<string, ResolvedSession>({
  max: envInt('JELLYFIN_SESSION_CACHE_MAX', 5000, 1),
});

// The runtime is not in any playstate payload, so it comes from the meta.
async function resolveSession(userUUID: string, itemId: string, known?: any): Promise<ResolvedSession | null> {
  const cacheKey = `${userUUID}:${itemId}`;
  const held = known ? undefined : resolvedSessions.get(cacheKey);
  if (held) return held;

  const descriptor = await decodeJellyfinId(itemId);
  if (!descriptor) return null;
  if (descriptor.k !== 'movie' && descriptor.k !== 'episode') return null;

  const videoId = stremioIdFor(descriptor);
  if (!videoId) return null;

  const stremioType = descriptor.k === 'movie' ? 'movie' : 'series';
  const meta = known ?? (await fetchMeta(userUUID, stremioType, descriptor.i));

  let runtimeMs: number | null = null;
  const aliases: string[] = [];
  if (meta) {
    let runtime = meta.runtime;
    if (descriptor.k === 'episode' && Array.isArray(meta.videos)) {
      const video = meta.videos.find((v: any) => String(v?.id) === videoId);
      if (video?.runtime) runtime = video.runtime;
    }
    runtimeMs = parseRuntimeMs(runtime);
    if (descriptor.k === 'movie') {
      const imdb = meta._imdbId || meta.imdb_id;
      if (imdb) aliases.push(String(imdb));
      if (meta._tmdbId) aliases.push(`tmdb:${meta._tmdbId}`);
    } else if (descriptor.k === 'episode' && !ANIME_VIDEO.test(videoId)) {
      const at = `:${descriptor.s}:${descriptor.e}`;
      const imdb = meta._imdbId || meta.imdb_id;
      if (imdb) aliases.push(`${imdb}${at}`);
      if (meta._tmdbId) aliases.push(`tmdb:${meta._tmdbId}${at}`);
      if (meta._tvdbId) aliases.push(`tvdb:${meta._tvdbId}${at}`);
    }
  }

  const session: ResolvedSession = { itemId, stremioType, videoId, descriptor, runtimeMs, aliases: aliases.filter((id) => id !== videoId) };
  if (meta) resolvedSessions.set(cacheKey, session, { ttl: envInt('JELLYFIN_SESSION_CACHE_TTL', 12 * 60 * 60, 60) * 1000 });
  return session;
}

// The percentage is over the file's own length: the player's if the client
// sends one, else what the stream addon reported, else the metadata's.
async function resolvePlaying(userUUID: string, itemId: string, body: any): Promise<ResolvedSession | null> {
  const session = await resolveSession(userUUID, itemId);
  if (!session) return null;
  const reported = ticksToMs(body?.Item?.RunTimeTicks ?? body?.NowPlayingItem?.RunTimeTicks ?? body?.RunTimeTicks);
  if (reported && reported > 0) return { ...session, runtimeMs: reported, runtimeFrom: 'client' };
  const { recallDuration } = require('./streams');
  const fileDuration = await recallDuration(body?.MediaSourceId ?? body?.mediaSourceId);
  return fileDuration ? { ...session, runtimeMs: fileDuration, runtimeFrom: 'file' } : session;
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
  played: boolean | null,
  edgeAt: number | null = null,
  at: number | null = null
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
        : `jellyfin|${session.videoId}|${event}|${positionMs ?? 0}${edgeAt ? `|r${edgeAt}` : ''}`,
    event,
    at: Math.floor((at ?? Date.now()) / 1000),
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

async function announce(userUUID: string, config: any, profile: string, session: ResolvedSession): Promise<void> {
  const { hasListeners, pushUserData } = require('./socket');
  if (!(await hasListeners(userUUID, profile))) return;
  const database: any = require('../database');
  const row = await database.getPlaystate(userUUID, session.videoId, profile);
  const positionMs = Number(row?.position_ms) || 0;
  const runtimeMs = Number(row?.runtime_ms) || session.runtimeMs || 0;
  const played = Boolean(Number(row?.played));
  let favourite = false;
  if (session.descriptor.k === 'movie' && config) {
    const { listedIds } = require('./watchlist');
    const listed: Set<string> = await listedIds(userUUID, config).catch(() => new Set<string>());
    favourite = [session.descriptor.i, ...session.aliases].some((id) => listed.has(String(id)));
  }
  const itemId = dashedGuid(normaliseJellyfinId(session.itemId));
  pushUserData(userUUID, profile, [{
    Key: itemId,
    ItemId: itemId,
    Played: played,
    PlayCount: playCountOf(played, row?.play_count),
    PlaybackPositionTicks: positionMs * TICKS_PER_MS,
    PlayedPercentage: positionMs > 0 && runtimeMs > 0 ? Math.min(100, (positionMs / runtimeMs) * 100) : played ? 100 : 0,
    LastPlayedDate: row?.last_played_at ? new Date(Number(row.last_played_at)).toISOString() : null,
    IsFavorite: favourite,
  }]);
}

async function recordPlaystate(
  userUUID: string,
  profile: string,
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number,
  played: boolean | null,
  config: any,
  finished = false,
  resetAll = false
): Promise<void> {
  await writePlaystate(userUUID, profile, session, event, positionMs, played, finished);
  // Dropped before a client is told, so the read-back it makes sees the change.
  const { forgetOwnWatches, invalidateResume } = require('./resume');
  if (resetAll) invalidateResume(userUUID);
  else if (played === true || event === 'unplayed') forgetOwnWatches(userUUID);
  announce(userUUID, config, profile, session).catch((error: any) =>
    logger.debug(`User data push failed for ${session.videoId}: ${error?.message || error}`)
  );
}

async function writePlaystate(
  userUUID: string,
  profile: string,
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number,
  played: boolean | null,
  finished = false,
  viewed = false,
  at: number | null = null
): Promise<void> {
  const database: any = require('../database');
  const videoId = session.videoId;
  const runtimeMs = session.runtimeMs ?? 0;

  try {
    if (event === 'unplayed') {
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, played: false, lastPlayedAt: null, origin: 'server' }, profile, session.aliases);
      return;
    }
    const now = Date.now();
    if (event === 'played') {
      const playedAt = at ?? now;
      // A date a client sent for an earlier viewing is logged as that viewing, and leaves a later one as the last.
      const held = at !== null ? await database.getPlaystate(userUUID, videoId, profile).catch(() => null) : null;
      const dated = Number(held?.last_played_at) > playedAt ? {} : { lastPlayedAt: playedAt, lastPlayedKind: viewed ? 'viewing' : 'mark' };
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, runtimeMs, played: true, ...dated, origin: 'server', watch: { at: playedAt, kind: 'first' } }, profile, session.aliases);
      return;
    }
    if (event === 'stop' && played === true) {
      const gapMs = runtimeMs > 0 ? runtimeMs / 2 : envInt('JELLYFIN_REWATCH_MIN_GAP_MINUTES', 10, 0) * 60_000;
      const watch = finished ? { at: now, kind: 'finish', gapMs } : undefined;
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, runtimeMs, played: true, lastPlayedAt: now, origin: 'server', ...(watch ? { watch } : {}) }, profile, session.aliases);
      return;
    }
    const { belowResumeFloor } = require('./resume');
    const kept = belowResumeFloor(positionMs, runtimeMs) ? 0 : positionMs;
    await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: kept, runtimeMs, lastPlayedAt: Date.now(), origin: 'server' }, profile, session.aliases);
  } catch (error: any) {
    logger.warn(`Playstate write failed for ${videoId}: ${error?.message || error}`);
  }
}

// The table records every play; trackers hear these reports only when the switch for the play's source is on.
export function tellsTrackers(config: any, source: PlaySourceId = 'jellyfin'): boolean {
  const { writesTrackers } = require('./profiles');
  return PLAY_SOURCES[source].scrobbles(config) && writesTrackers(config);
}

async function report(
  req: any,
  body: any,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  source: PlaySourceId = 'jellyfin'
): Promise<void> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  if (!userUUID || !itemId) return;

  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config) return;

  const session = await resolvePlaying(userUUID, itemId, body);
  if (!session) {
    logger.debug(`No playable session for ${itemId}`);
    return;
  }
  logger.debug(`${event} from ${String(req.get?.('user-agent') || '').split(' ')[0] || 'unknown client'} for ${session.videoId} source ${body?.MediaSourceId ?? '?'}: runtime ${session.runtimeMs ?? 0}ms from the ${session.runtimeFrom ?? 'metadata'}`);

  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  const key = `${userUUID}:${profile}:${itemId}`;
  const known = await getPosition(key);
  const device = require('./context').clientInfo(req).deviceId as string;
  const app = appOf(req);
  const playSession = playSessionOf(body);
  const reported = ticksToMs(body?.PositionTicks ?? body?.positionTicks);
  if (known?.marked) {
    if (event === 'stop') deletePosition(key);
    else setPosition(key, { ...known, positionMs: reported ?? known.positionMs, at: Date.now(), paused: event === 'pause' });
    return;
  }
  // A resume reported at zero is the client's habit, not a seek to the start.
  const resumedFrom = event === 'start' && known?.paused ? known.at : null;
  // A start, pause or resume can come back at a position already reported, so each carries when its state began.
  const fresh = event === 'start' && (!known || (known.paused === false && !sameSession(known, device, playSession)));
  const edgeAt = resumedFrom ?? (event === 'pause' && known?.paused === false ? known.at : fresh ? Date.now() : null);
  const positionMs = (resumedFrom && !reported ? known?.positionMs : reported) ?? known?.positionMs ?? 0;
  logger.debug(`${event} ${session.videoId}: client sent ${reported ?? 'no'} position, held ${known?.positionMs ?? 'none'}, using ${positionMs}ms`);

  // A client re-sends Playing while it runs; reopening an already-playing
  // session is noise. A resume comes through the pause edge instead.
  if (event === 'start' && known && known.paused === false && sameSession(known, device, playSession)) {
    setPosition(key, { positionMs, at: Date.now(), paused: false, viewer: req.jellyfin?.profileId ?? null, device, app, playSession, playedAt: known.playedAt, rewound: known.rewound });
    return;
  }
  const same = known && sameSession(known, device, playSession);
  const playedAt = same ? known.playedAt : undefined;

  let played: boolean | null = null;
  if (event === 'played') played = true;
  if (event === 'stop') {
    played =
      session.runtimeMs && session.runtimeMs > 0
        ? (positionMs / session.runtimeMs) * 100 >= (await watchedAtPercent(req))
        : false;
    deletePosition(key);
  } else {
    // Recorded as playing, not unknown: a following tick reporting the same
    // state would otherwise read as a change and reopen the session.
    setPosition(key, { positionMs, at: Date.now(), paused: event === 'pause', viewer: req.jellyfin?.profileId ?? null, device, app, playSession, playedAt, rewound: same ? known.rewound : undefined });
  }

  if (playedAt && (event === 'start' || event === 'pause' || played === true)) {
    if (event === 'stop') await recordPlaystate(userUUID, profile, session, event, positionMs, played, config);
    return;
  }
  await settle(userUUID, config, profile, session, event, positionMs, played, edgeAt, source);
}

async function settle(
  userUUID: string,
  config: any,
  profile: string,
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number,
  played: boolean | null,
  edgeAt: number | null = null,
  source: PlaySourceId = 'jellyfin'
): Promise<void> {
  const tells = tellsTrackers(config, source);
  // The table is written before any tracker is told, so a read never waits on one.
  await recordPlaystate(userUUID, profile, session, event, positionMs, played, config, event === 'stop' && played === true, !tells);
  if (played === true && session.descriptor.k === 'episode') {
    const { undropOnWatch } = require('./dropped');
    undropOnWatch(userUUID, config, [session.descriptor.i]);
  }
  if (played === true) require('./watchlist').leaveWatchlistOnWatch(userUUID, config, [session.descriptor]);

  if (!tells) return;

  // A pause at zero is what a collapsed position looks like, and a real one says
  // nothing a tracker can use, so it is remembered without writing a resume
  // point every service would then show as continue-watching from the start.
  if (event === 'pause' && positionMs <= 0) {
    logger.debug(`Not reporting a pause at zero for ${session.videoId}`);
    return;
  }

  await tellTrackers(userUUID, config, session, event, positionMs, played, true, edgeAt);
}

async function tellTrackers(
  userUUID: string,
  config: any,
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number,
  played: boolean | null,
  refreshWatched = true,
  edgeAt: number | null = null,
  at: number | null = null
): Promise<void> {
  const { handlePlaybackReport } = require('../playbackHandler');
  await handlePlaybackReport(
    session.stremioType,
    session.videoId,
    reportFor(session, event, positionMs, played, edgeAt, at),
    config,
    userUUID
  );

  // The trackers are told later, so what this server just recorded shows in the
  // held snapshot now; the snapshots are read again once the writes land.
  if ((event === 'stop' && played === true) || (refreshWatched && (event === 'played' || event === 'unplayed'))) {
    const { applyLocalWatch } = require('./watched');
    await applyLocalWatch(config, {
      videoId: session.videoId,
      metaId: session.descriptor.i,
      kind: session.descriptor.k === 'episode' ? 'episode' : 'movie',
      played: event !== 'unplayed',
    }).catch(() => undefined);
  }
}

export async function recordPlaying(req: any, body: any, source: PlaySourceId = 'jellyfin'): Promise<void> {
  await report(req, body, 'start', source);
}

export async function recordStopped(req: any, body: any, source: PlaySourceId = 'jellyfin'): Promise<void> {
  await report(req, body, 'stop', source);
}

/** The mark-watched a client offers on an item, taken without it being played. */
// A client marks a season or a whole series with one call on that item's id;
// the mark applies to each aired episode in it. The table is written for all
// of them before this returns, since the client reads the item back straight
// after and a half-marked season shows no tick; the trackers are told after.
async function markEach(req: any, body: any, event: 'played' | 'unplayed', upTo = false, source: PlaySourceId = 'jellyfin', at: number | null = null): Promise<void> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  if (!userUUID || !itemId) return;

  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config) return;

  const { profileKey } = require('./profiles');
  const profile = profileKey(config);

  await closeOpenSession(userUUID, config, profile, itemId, event === 'played', source);

  const marked = await markedItemIds(userUUID, itemId, upTo);
  if (upTo) marked.ids = await unplayedAmong(userUUID, config, profile, marked.ids);
  await markItems(userUUID, config, profile, marked, event, source, at);
}

// A mark on a title the server still holds as playing is the stop that never arrived.
// Marked watched, the session is kept until the client's own stop, which would otherwise save a resume point over the watch.
async function closeOpenSession(userUUID: string, config: any, profile: string, itemId: string, played: boolean, source: PlaySourceId): Promise<boolean> {
  const key = `${userUUID}:${profile}:${itemId}`;
  const open = await getPosition(key);
  if (!open || !isPlayable(await decodeJellyfinId(itemId))) return false;
  if (open.marked) {
    if (!played) setPosition(key, { ...open, marked: undefined });
    return true;
  }
  if (!open.paused) {
    const session = await resolveSession(userUUID, itemId);
    if (session && tellsTrackers(config, source)) {
      const at = played ? (session.runtimeMs ?? open.positionMs) : open.positionMs;
      await tellTrackers(userUUID, config, session, 'stop', at, played, false).catch((error: any) =>
        logger.debug(`Closing the open session before a mark failed for ${itemId}: ${error?.message || error}`)
      );
    }
  }
  if (played) setPosition(key, { ...open, at: Date.now(), marked: true });
  else if (!open.paused) deletePosition(key);
  return true;
}

type MarkTarget = { ids: string[]; meta?: any; scope?: 'season' | 'series'; metaId?: string };

async function markItems(
  userUUID: string,
  config: any,
  profile: string,
  marked: MarkTarget,
  event: 'played' | 'unplayed',
  source: PlaySourceId,
  at: number | null = null
): Promise<void> {
  const played = event === 'played';
  const itemId = marked.metaId ?? marked.ids[0];
  const tells = tellsTrackers(config, source);
  const sessions = (await mapWithConcurrency(marked.ids, 8, async (id: string) => {
    const session = await resolveSession(userUUID, id, marked.meta);
    if (!session) {
      logger.debug(`No playable session for ${id}`);
      return null;
    }
    const key = `${userUUID}:${profile}:${id}`;
    // A session still open when the title is marked was watched to here, so the mark dates a viewing.
    const viewed = played && Boolean((await getPosition(key))?.marked);
    if (!viewed) deletePosition(key);
    await writePlaystate(userUUID, profile, session, event, 0, played, false, viewed, at);
    return session;
  })).filter((s): s is ResolvedSession => s !== null);

  // Every row is written before anything is dropped or a client told, so none reads half a season.
  const { forgetOwnWatches, invalidateResume } = require('./resume');
  if (tells) forgetOwnWatches(userUUID);
  else invalidateResume(userUUID);
  for (const session of sessions) {
    announce(userUUID, config, profile, session).catch((error: any) =>
      logger.debug(`User data push failed for ${session.videoId}: ${error?.message || error}`)
    );
  }

  if (played) {
    const { undropOnWatch } = require('./dropped');
    undropOnWatch(userUUID, config, sessions.filter((session) => session.descriptor.k === 'episode').map((session) => session.descriptor.i));
    require('./watchlist').leaveWatchlistOnWatch(userUUID, config, sessions.map((session) => session.descriptor));
  }
  if (!tells) return;
  // A season or series goes to the trackers as one batch, not an event per episode.
  if (marked.scope) {
    const { handlePlaybackReport } = require('../playbackHandler');
    handlePlaybackReport('series', marked.metaId, {
      scope: marked.scope,
      event,
      metaId: marked.metaId,
      videos: sessions.map((session) => ({ videoId: session.videoId })),
      ...(at ? { at: Math.floor(at / 1000) } : {}),
    }, config, userUUID).catch((error: any) => logger.debug(`Mark report failed for ${itemId}: ${error?.message || error}`));
    return;
  }
  const { applyLocalWatch } = require('./watched');
  mapWithConcurrency(sessions, 3, (session: ResolvedSession) => tellTrackers(userUUID, config, session, event, 0, played, false, null, at))
    .then(async () => {
      for (const session of sessions) {
        await applyLocalWatch(config, {
          videoId: session.videoId,
          metaId: session.descriptor.i,
          kind: session.descriptor.k === 'episode' ? 'episode' : 'movie',
          played,
        }).catch(() => undefined);
      }
    })
    .catch((error: any) => logger.debug(`Mark report failed for ${itemId}: ${error?.message || error}`));
}

const isPlayable = (descriptor: any): boolean => descriptor?.k === 'movie' || descriptor?.k === 'episode';

/**
 * The item itself, or each aired episode of the season or series it names, with the meta
 * they share. Up to an episode, the aired episodes of its series up to and including it.
 */
async function markedItemIds(
  userUUID: string,
  itemId: string,
  upTo = false
): Promise<{ ids: string[]; meta?: any; scope?: 'season' | 'series'; metaId?: string }> {
  const descriptor = await decodeJellyfinId(itemId);
  if (upTo && descriptor?.k === 'episode') {
    const meta = await fetchMeta(userUUID, 'series', descriptor.i);
    const now = Date.now();
    const ids: string[] = [];
    for (const video of Array.isArray(meta?.videos) ? meta.videos : []) {
      const aired = Date.parse(video.released || '');
      if (Number.isFinite(aired) && aired > now) continue;
      const parsed = parseStremioId(String(video.id ?? ''));
      const season = parsed?.season ?? null;
      const episode = parsed?.episode;
      if (!parsed || typeof episode !== 'number') continue;
      if (descriptor.s === null) {
        if (season !== null || episode > descriptor.e) continue;
      } else if (season === null || season === 0 || season > descriptor.s || (season === descriptor.s && episode > descriptor.e)) {
        continue;
      }
      ids.push(encodeJellyfinId({ k: 'episode', t: descriptor.t, i: parsed.base, s: season, e: episode }));
    }
    return { ids, meta, scope: 'series', metaId: descriptor.i };
  }
  if (!descriptor || (descriptor.k !== 'season' && descriptor.k !== 'series')) return { ids: [itemId] };

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
  return { ids, meta, scope: descriptor.k, metaId: descriptor.i };
}

/** A play reported by a client that does not play through this server's own Jellyfin routes. */
export interface ClientPlay {
  action: 'start' | 'pause' | 'stop';
  descriptor: Descriptor;
  positionMs: number;
  durationMs: number;
}

/** A watched or unwatched mark from such a client: one title, or the videos of it that changed. */
export interface ClientMark {
  played: boolean;
  title: Descriptor;
  videos: Descriptor[];
  scope?: 'season';
}

export async function recordClientPlay(req: any, play: ClientPlay, source: PlaySourceId): Promise<void> {
  const body = {
    ItemId: encodeJellyfinId(play.descriptor),
    PositionTicks: play.positionMs * TICKS_PER_MS,
    ...(play.durationMs > 0 ? { RunTimeTicks: play.durationMs * TICKS_PER_MS } : {}),
  };
  if (play.action === 'stop') return recordStopped(req, body, source);
  const { loadConfig } = require('./context');
  const { profileKey } = require('./profiles');
  const config = await loadConfig(req);
  if (!config) return;
  const itemId = normaliseJellyfinId(body.ItemId);
  const key = `${req.params.userUUID}:${profileKey(config)}:${itemId}`;
  const known = await getPosition(key);
  if (play.action === 'start' && known && !PLAY_SOURCES[source].sendsProgress && (await outlastedPlay(req.params.userUUID, itemId, known, play.durationMs))) {
    deletePosition(key);
    return recordPlaying(req, body, source);
  }
  if (play.action === 'start' && !known) return recordPlaying(req, body, source);
  await recordProgress(req, { ...body, IsPaused: play.action === 'pause' }, source);
}

// A client silent while playing leaves a closed or killed play held as playing; held past what it had left, the next start is a new play.
async function outlastedPlay(userUUID: string, itemId: string, known: SessionPosition, durationMs: number): Promise<boolean> {
  if (known.paused !== false) return false;
  const runtimeMs = durationMs > 0 ? durationMs : (await resolveSession(userUUID, itemId))?.runtimeMs ?? null;
  if (!runtimeMs) return false;
  const marginMs = envInt('PLAY_ENDED_MARGIN_MINUTES', 15, 0) * 60_000;
  return Date.now() - known.at > Math.max(0, runtimeMs - known.positionMs) + marginMs;
}

export async function recordClientMark(req: any, mark: ClientMark, source: PlaySourceId): Promise<void> {
  const userUUID = req.params.userUUID;
  const config = await require('./context').loadConfig(req);
  if (!config) return;
  const ids = mark.videos.map((video) => encodeJellyfinId(video));
  const marked: MarkTarget = ids.length
    ? { ids, metaId: mark.title.k === 'movie' || mark.title.k === 'series' ? mark.title.i : undefined, ...(mark.scope ? { scope: mark.scope } : {}) }
    : mark.title.k === 'movie'
      ? { ids: [encodeJellyfinId(mark.title)] }
      : await markedItemIds(userUUID, encodeJellyfinId(mark.title));
  if (!marked.ids.length) return;

  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  for (const id of marked.ids) await closeOpenSession(userUUID, config, profile, id, mark.played, source);
  await markItems(userUUID, config, profile, marked, mark.played ? 'played' : 'unplayed', source);
}

export async function recordPlayed(req: any, body: any, source: PlaySourceId = 'jellyfin', at: number | null = null): Promise<void> {
  await markEach(req, body, 'played', false, source, at);
}

/** A played date a client sent, read as ISO time; one still to come is now, and one that is no date is none. */
export function clientPlayedAt(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at <= 0) return null;
  return Math.min(at, Date.now());
}

export async function recordUnplayed(req: any, body: any, source: PlaySourceId = 'jellyfin'): Promise<void> {
  await markEach(req, body, 'unplayed', false, source);
}

export async function recordWatchDate(req: any, itemId: string, from: number | null, to: number, merge = false): Promise<boolean> {
  const userUUID = req.params?.userUUID;
  if (!userUUID) return false;
  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config) return false;
  const session = await resolveSession(userUUID, itemId);
  if (!session) return false;

  const { profileKey } = require('./profiles');
  const { videoIdAliases } = require('./aliases');
  const profile = profileKey(config);
  const spellings = [session.videoId, ...session.aliases, ...(await videoIdAliases(session.videoId).catch(() => [] as string[]))];
  const runtimeMs = session.runtimeMs ?? 0;
  const sameViewing = runtimeMs > 0 ? runtimeMs : envInt('JELLYFIN_REWATCH_MIN_GAP_MINUTES', 10, 0) * 60_000;
  const database: any = require('../database');
  const { moved, latestBefore, latestAfter, apart } = await database.redateWatch(userUUID, profile, spellings, from, to, Math.max(sameViewing, 60_000), merge);
  if (!moved) return false;

  const { invalidateResume } = require('./resume');
  invalidateResume(userUUID);
  announce(userUUID, config, profile, session).catch((error: any) =>
    logger.debug(`User data push failed for ${session.videoId}: ${error?.message || error}`)
  );
  if (from === null || !tellsTrackers(config, 'dashboard')) return true;
  const { enqueueTrackerWrites, hasCredential } = require('../trackerOutbox');
  const latest = session.descriptor.k === 'episode' && latestAfter !== latestBefore ? latestAfter : null;
  const services = ['mdblist', 'publicmetadb', ...(latest ? ['simkl'] : [])].filter((service) => hasCredential(config, service));
  await enqueueTrackerWrites(userUUID, config, services.map((service) => ({
    service, op: 'redate', item: session.descriptor.i,
    payload: { type: session.stremioType, id: session.videoId, from, to, latest, ...(apart ? { apart: true } : {}) },
  }))).catch((error: any) => logger.debug(`Moving the watch date on trackers failed for ${session.videoId}: ${error?.message || error}`));
  return true;
}

/** The episode and every aired one before it in its series, specials left out. */
export async function recordPlayedUpTo(req: any, itemId: string, source: PlaySourceId = 'jellyfin'): Promise<void> {
  await markEach(req, { ItemId: itemId }, 'played', true, source);
}

async function unplayedAmong(userUUID: string, config: any, profile: string, ids: string[]): Promise<string[]> {
  const { applyWatchedState, watchedSnapshot } = require('./watched');
  const items = ids.map((id) => ({ Id: id, UserData: {} as any }));
  await applyWatchedState(items, await watchedSnapshot(userUUID, config, { patient: true }), userUUID, profile, config);
  return items.filter((item) => !item.UserData?.Played).map((item) => item.Id);
}

/**
 * Progress is not forwarded anywhere: no tracker has an endpoint for it. It is
 * only remembered, so a stop that arrives without a position still has one.
 */
export async function recordProgress(req: any, body: any, source: PlaySourceId = 'jellyfin'): Promise<void> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  const positionMs = ticksToMs(body?.PositionTicks ?? body?.positionTicks);
  if (!userUUID || !itemId) return;
  if (positionMs === null) {
    logger.debug(`Progress for ${itemId} carries no position`);
    return;
  }

  const { loadConfig } = require('./context');
  const { profileKey } = require('./profiles');
  const key = `${userUUID}:${profileKey(await loadConfig(req))}:${itemId}`;
  const previous = await getPosition(key);
  const paused = body?.IsPaused === true || body?.isPaused === true;
  if (previous?.marked) {
    setPosition(key, { ...previous, positionMs, at: Date.now(), paused });
    return;
  }

  // A client keeps reporting every few seconds while paused, so only the change
  // is worth acting on: pausing stores a resume point, resuming reopens the
  // session at the position it left off. The state is left for report() to
  // write, since it decides against what the session was, not what it is.
  const changed = previous !== undefined && previous.paused !== paused;
  const startsPaused = previous === undefined && paused;
  const session = playSessionOf(body);
  const newSession = !paused && !!previous?.playSession && !!session && previous.playSession !== session;
  if (!changed && !startsPaused && !newSession) {
    const now = Date.now();
    const next: SessionPosition = { positionMs, at: now, paused, writtenAt: previous?.writtenAt, writtenMs: previous?.writtenMs, viewer: req.jellyfin?.profileId ?? previous?.viewer ?? null, device: previous?.device ?? require('./context').clientInfo(req).deviceId, app: previous?.app ?? appOf(req), playSession: previous?.playSession ?? playSessionOf(body), playedAt: previous?.playedAt, rewound: previous?.rewound };
    // Table only; a tracker still hears edges alone.
    const interval = envInt('JELLYFIN_PROGRESS_WRITE_INTERVAL', 60, 0) * 1000;
    const moved = positionMs !== (previous?.writtenMs ?? -1);
    if (paused && previous && Math.abs(positionMs - previous.positionMs) >= 1000) {
      const config = await loadConfig(req);
      const session = config ? await resolvePlaying(userUUID, itemId, body) : null;
      if (session) {
        await recordPlaystate(userUUID, profileKey(config), session, 'pause', positionMs, null, config);
        next.writtenAt = now;
        next.writtenMs = positionMs;
      }
    } else if (interval > 0 && !paused && moved && now - (previous?.writtenAt ?? 0) >= interval) {
      const config = await loadConfig(req);
      const session = config ? await resolvePlaying(userUUID, itemId, body) : null;
      if (session) {
        // Past the mark the title counts as watched now, as a Jellyfin server does it,
        // so a client that moves on without a usable stop still leaves it watched.
        // Rewound below it, the position is kept again; the watch stands.
        const finished = Boolean(session.runtimeMs && (positionMs / session.runtimeMs) * 100 >= (await watchedAtPercent(req)));
        logger.debug(`Progress ${session.videoId} at ${positionMs}ms${finished ? ', past the watched mark' : ''}`);
        // Only a position played up to counts, not one jumped to: since the last report it
        // moved no further than playback could have, so scrubbing ahead and back marks nothing.
        const played = previous ? positionMs - previous.positionMs : -1;
        const continuous = played >= 0 && played <= (now - (previous?.at ?? now)) * 2 + 10_000;
        if (finished && !previous?.playedAt && !continuous) {
          logger.debug(`Progress ${session.videoId} jumped past the watched mark; waiting for it to play on`);
          setPosition(key, next);
          return;
        }
        if (finished && !previous?.playedAt) {
          next.playedAt = now;
          setPosition(key, next);
          await settle(userUUID, config, profileKey(config), session, 'stop', positionMs, true, null, source);
          return;
        }
        if (!finished) {
          await recordPlaystate(userUUID, profileKey(config), session, 'start', positionMs, null, config);
          if (previous?.playedAt) next.rewound = true;
        } else if (previous?.rewound) {
          await recordPlaystate(userUUID, profileKey(config), session, 'stop', positionMs, true, config);
          next.rewound = false;
        }
        next.writtenAt = now;
        next.writtenMs = positionMs;
      }
    }
    setPosition(key, next);
    return;
  }

  await report(req, body, paused ? 'pause' : 'start', source);
}

/**
 * The one-call edit of an item's state a client offers next to mark-watched: a
 * played flag, or a resume position, which cleared is what drops the item from
 * continue watching. Answers the state the item is now in.
 */
export async function recordUserData(req: any, body: any, source: PlaySourceId = 'jellyfin'): Promise<{ played: boolean; positionMs: number; rating?: number | null; at?: number } | null> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  if (!userUUID || !itemId) return null;
  const at = clientPlayedAt(body?.LastPlayedDate ?? body?.lastPlayedDate);

  const rated = body && ('Rating' in body || 'rating' in body);
  if (rated) {
    const { ratingFrom, rateItem } = require('./ratings');
    const { loadConfig } = require('./context');
    const config = await loadConfig(req);
    const descriptor = await decodeJellyfinId(itemId);
    const rating = ratingFrom(body.Rating ?? body.rating);
    if (!config || !descriptor || !(await rateItem(userUUID, config, descriptor, rating))) return null;
    const hasMore = ['Played', 'played', 'PlaybackPositionTicks', 'playbackPositionTicks'].some((key) => key in body);
    if (!hasMore) {
      const { profileKey } = require('./profiles');
      const video = stremioIdFor(descriptor);
      const row = video ? await require('../database').getPlaystate(userUUID, video, profileKey(config)).catch(() => null) : null;
      return { played: Boolean(row?.played), positionMs: Number(row?.position_ms) || 0, rating };
    }
  }

  const played = body?.Played ?? body?.played;
  if (played === true || played === false) {
    await markEach(req, { ItemId: itemId }, played ? 'played' : 'unplayed', false, source, played ? at : null);
    return { played, positionMs: 0, ...(played && at !== null ? { at } : {}) };
  }

  const asked = ticksToMs(body?.PlaybackPositionTicks ?? body?.playbackPositionTicks);
  if (asked === null) {
    logger.debug(`User data for ${itemId} carries neither Played nor a position: ${Object.keys(body || {}).join(',') || 'empty body'} (${req.get?.('content-type') || 'no content type'})`);
    return null;
  }

  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config) return null;

  const session = await resolveSession(userUUID, itemId);
  if (!session) {
    logger.debug(`No playable session for ${itemId}`);
    return null;
  }
  const positionMs = require('./resume').belowResumeFloor(asked, session.runtimeMs ?? 0) ? 0 : asked;

  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  deletePosition(`${userUUID}:${profile}:${itemId}`);
  await upsertPlaystateEverywhere(userUUID, session.videoId, { positionMs, runtimeMs: session.runtimeMs ?? 0, ...(positionMs > 0 ? { lastPlayedAt: at ?? Date.now() } : {}), origin: 'server' }, profile, session.aliases);
  announce(userUUID, config, profile, session).catch((error: any) =>
    logger.debug(`User data push failed for ${session.videoId}: ${error?.message || error}`)
  );

  const { invalidateResume } = require('./resume');
  invalidateResume(userUUID);

  // Cleared here means cleared on the trackers too, or their copy would come
  // back through the shelf on any device reading them directly.
  if (positionMs === 0 && tellsTrackers(config, source)) {
    const { enqueueTrackerWrites, hasCredential } = require('../trackerOutbox');
    const services = (['simkl', 'mdblist', 'publicmetadb'] as const).filter((service) => hasCredential(config, service));
    await enqueueTrackerWrites(userUUID, config, services.map((service) => ({
      service, op: 'clearResume', item: session.descriptor.i, coalesce: `resume:${session.videoId}`,
      payload: { type: session.stremioType, id: session.videoId },
    }))).catch((error: any) => logger.debug(`Clearing the resume point on trackers failed for ${session.videoId}: ${error?.message || error}`));
  }

  const database: any = require('../database');
  const row = await database.getPlaystate(userUUID, session.videoId, profile);
  return { played: Boolean(row?.played), positionMs, ...(positionMs > 0 && at !== null ? { at } : {}) };
}
