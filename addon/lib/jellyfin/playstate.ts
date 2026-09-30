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
  return envInt('JELLYFIN_PLAYED_THRESHOLD', 80, 1);
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

function liveWindowMs(): number {
  return envInt('JELLYFIN_LIVE_SESSION_WINDOW', 60 * 60, 60) * 1000;
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
  redis.multi()
    .hsetex(POSITIONS_KEY, 'EX', ttl, 'FIELDS', 1, key, JSON.stringify(value))
    .expire(POSITIONS_KEY, ttl, 'NX')
    .expire(POSITIONS_KEY, ttl, 'GT')
    .zadd(POSITIONS_INDEX, value.at, key)
    .expire(POSITIONS_INDEX, ttl, 'NX')
    .expire(POSITIONS_INDEX, ttl, 'GT')
    .exec()
    .catch(() => undefined);
}

function deletePosition(key: string): void {
  positions.delete(key);
  if (redis) redis.multi().hdel(POSITIONS_KEY, key).zrem(POSITIONS_INDEX, key).exec().catch(() => undefined);
}

export type LiveSession = { userUUID: string; profile: string; viewer: string | null; itemId: string; positionMs: number; at: number; paused: boolean };

/**
 * Every session the instance has heard from, newest first. Read from Redis so
 * the answer covers other processes and survives a restart; this process's own
 * entries win, being the fresher of the two.
 */
export async function liveSessions(): Promise<LiveSession[]> {
  const cutoff = Date.now() - liveWindowMs();
  const rows = new Map<string, SessionPosition>();
  for (const [key, value] of positions.entries()) if (value.at >= cutoff) rows.set(key, value);

  if (redis) {
    try {
      const cap = envInt('JELLYFIN_SESSION_CACHE_MAX', 5000, 1);
      const keys: string[] = await redis.zrevrangebyscore(POSITIONS_INDEX, '+inf', cutoff, 'LIMIT', 0, cap);
      redis.zremrangebyscore(POSITIONS_INDEX, '-inf', `(${cutoff}`).catch(() => undefined);
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
    out.push({ userUUID, profile: profile || '', viewer: value.viewer ?? null, itemId, positionMs: value.positionMs, at: value.at, paused: value.paused === true });
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
      const live: string[] = await redis.zrevrangebyscore(POSITIONS_INDEX, '+inf', cutoff, 'LIMIT', 0, cap);
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

  const session: ResolvedSession = { stremioType, videoId, descriptor, runtimeMs, aliases: aliases.filter((id) => id !== videoId) };
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
  resumedFrom: number | null = null
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
        : `jellyfin|${session.videoId}|${event}|${positionMs ?? 0}${resumedFrom ? `|r${resumedFrom}` : ''}`,
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
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, played: false, lastPlayedAt: null }, profile, session.aliases);
      return;
    }
    if (event === 'played') {
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, runtimeMs, played: true, lastPlayedAt: Date.now() }, profile, session.aliases);
      return;
    }
    if (event === 'stop' && played === true) {
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, runtimeMs, played: true, lastPlayedAt: Date.now() }, profile, session.aliases);
      return;
    }
    await upsertPlaystateEverywhere(userUUID, videoId, { positionMs, runtimeMs, lastPlayedAt: Date.now() }, profile, session.aliases);
  } catch (error: any) {
    logger.warn(`Playstate write failed for ${videoId}: ${error?.message || error}`);
  }
}

// The table records every play; trackers hear these reports only in playback mode.
function tellsTrackers(config: any): boolean {
  const { writesTrackers } = require('./profiles');
  return Boolean(config?.playbackReporting) && writesTrackers(config);
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
  const reported = ticksToMs(body?.PositionTicks ?? body?.positionTicks);
  // A resume reported at zero is the client's habit, not a seek to the start.
  const resumedFrom = event === 'start' && known?.paused ? known.at : null;
  const positionMs = (resumedFrom && !reported ? known?.positionMs : reported) ?? known?.positionMs ?? 0;
  logger.debug(`${event} ${session.videoId}: client sent ${reported ?? 'no'} position, held ${known?.positionMs ?? 'none'}, using ${positionMs}ms`);

  // A client re-sends Playing while it runs; reopening an already-playing
  // session is noise. A resume comes through the pause edge instead.
  if (event === 'start' && known && known.paused === false) {
    setPosition(key, { positionMs, at: Date.now(), paused: false, viewer: req.jellyfin?.profileId ?? null });
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
    setPosition(key, { positionMs, at: Date.now(), paused: event === 'pause', viewer: req.jellyfin?.profileId ?? null });
  }

  // The table is written before any tracker is told, so a read never waits on one.
  await recordPlaystate(userUUID, profile, session, event, positionMs, played);
  if (played === true && session.descriptor.k === 'episode') {
    const { undropOnWatch } = require('./dropped');
    undropOnWatch(userUUID, config, [session.descriptor.i]);
  }

  if (!tellsTrackers(config)) {
    const { invalidateResume } = require('./resume');
    invalidateResume(userUUID);
    return;
  }

  // A pause at zero is what a collapsed position looks like, and a real one says
  // nothing a tracker can use, so it is remembered without writing a resume
  // point every service would then show as continue-watching from the start.
  if (event === 'pause' && positionMs <= 0) {
    logger.debug(`Not reporting a pause at zero for ${session.videoId}`);
    return;
  }

  await tellTrackers(userUUID, config, session, event, positionMs, played, true, resumedFrom);
}

async function tellTrackers(
  userUUID: string,
  config: any,
  session: ResolvedSession,
  event: 'start' | 'pause' | 'stop' | 'played' | 'unplayed',
  positionMs: number,
  played: boolean | null,
  refreshWatched = true,
  resumedFrom: number | null = null
): Promise<void> {
  const { handlePlaybackReport } = require('../playbackHandler');
  await handlePlaybackReport(
    session.stremioType,
    session.videoId,
    reportFor(session, event, positionMs, played, resumedFrom),
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
async function markEach(req: any, body: any, event: 'played' | 'unplayed', upTo = false): Promise<void> {
  const userUUID = req.params?.userUUID;
  const itemId = bodyItemId(req, body);
  if (!userUUID || !itemId) return;

  const { loadConfig } = require('./context');
  const config = await loadConfig(req);
  if (!config) return;

  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  const played = event === 'played';

  // A mark on a title the server still holds as playing is the stop that never arrived.
  const open = await getPosition(`${userUUID}:${profile}:${itemId}`);
  if (open && !open.paused && isPlayable(await decodeJellyfinId(itemId))) {
    const session = await resolveSession(userUUID, itemId);
    deletePosition(`${userUUID}:${profile}:${itemId}`);
    if (session && tellsTrackers(config)) {
      const at = played ? (session.runtimeMs ?? open.positionMs) : open.positionMs;
      await tellTrackers(userUUID, config, session, 'stop', at, played, false).catch((error: any) =>
        logger.debug(`Closing the open session before a mark failed for ${itemId}: ${error?.message || error}`)
      );
    }
  }

  const marked = await markedItemIds(userUUID, itemId, upTo);
  if (upTo) marked.ids = await unplayedAmong(userUUID, config, profile, marked.ids);
  const sessions = (await mapWithConcurrency(marked.ids, 8, async (id: string) => {
    const session = await resolveSession(userUUID, id, marked.meta);
    if (!session) {
      logger.debug(`No playable session for ${id}`);
      return null;
    }
    deletePosition(`${userUUID}:${profile}:${id}`);
    await recordPlaystate(userUUID, profile, session, event, 0, played);
    return session;
  })).filter((s): s is ResolvedSession => s !== null);

  if (played) {
    const { undropOnWatch } = require('./dropped');
    undropOnWatch(userUUID, config, sessions.filter((session) => session.descriptor.k === 'episode').map((session) => session.descriptor.i));
  }
  if (!tellsTrackers(config)) {
    const { invalidateResume } = require('./resume');
    invalidateResume(userUUID);
    return;
  }
  // A season or series goes to the trackers as one batch, not an event per episode.
  if (marked.scope) {
    const { handlePlaybackReport } = require('../playbackHandler');
    const { invalidateResume } = require('./resume');
    invalidateResume(userUUID);
    handlePlaybackReport('series', marked.metaId, {
      scope: marked.scope,
      event,
      metaId: marked.metaId,
      videos: sessions.map((session) => ({ videoId: session.videoId })),
    }, config, userUUID).catch((error: any) => logger.debug(`Mark report failed for ${itemId}: ${error?.message || error}`));
    return;
  }
  const { applyLocalWatch } = require('./watched');
  mapWithConcurrency(sessions, 3, (session: ResolvedSession) => tellTrackers(userUUID, config, session, event, 0, played, false))
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

export async function recordPlayed(req: any, body: any): Promise<void> {
  await markEach(req, body, 'played');
}

export async function recordUnplayed(req: any, body: any): Promise<void> {
  await markEach(req, body, 'unplayed');
}

/** The episode and every aired one before it in its series, specials left out. */
export async function recordPlayedUpTo(req: any, itemId: string): Promise<void> {
  await markEach(req, { ItemId: itemId }, 'played', true);
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
export async function recordProgress(req: any, body: any): Promise<void> {
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

  // A client keeps reporting every few seconds while paused, so only the change
  // is worth acting on: pausing stores a resume point, resuming reopens the
  // session at the position it left off. The state is left for report() to
  // write, since it decides against what the session was, not what it is.
  const changed = previous !== undefined && previous.paused !== paused;
  const startsPaused = previous === undefined && paused;
  if (!changed && !startsPaused) {
    const now = Date.now();
    const next: SessionPosition = { positionMs, at: now, paused, writtenAt: previous?.writtenAt, writtenMs: previous?.writtenMs, viewer: req.jellyfin?.profileId ?? previous?.viewer ?? null };
    // Table only; a tracker still hears edges alone.
    const interval = envInt('JELLYFIN_PROGRESS_WRITE_INTERVAL', 60, 0) * 1000;
    const moved = positionMs !== (previous?.writtenMs ?? -1);
    if (interval > 0 && !paused && moved && now - (previous?.writtenAt ?? 0) >= interval) {
      const config = await loadConfig(req);
      const session = config ? await resolvePlaying(userUUID, itemId, body) : null;
      if (session) {
        logger.debug(`Progress ${session.videoId} at ${positionMs}ms`);
        await recordPlaystate(userUUID, profileKey(config), session, 'start', positionMs, null);
        next.writtenAt = now;
        next.writtenMs = positionMs;
      }
    }
    setPosition(key, next);
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
  if (positionMs === null) {
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

  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  deletePosition(`${userUUID}:${profile}:${itemId}`);
  await upsertPlaystateEverywhere(userUUID, session.videoId, { positionMs, runtimeMs: session.runtimeMs ?? 0 }, profile, session.aliases);

  const { invalidateResume } = require('./resume');
  invalidateResume(userUUID);

  // Cleared here means cleared on the trackers too, or their copy would come
  // back through the shelf on any device reading them directly.
  if (positionMs === 0 && tellsTrackers(config)) {
    const { enqueueTrackerWrites, hasCredential } = require('../trackerOutbox');
    const services = (['simkl', 'mdblist', 'publicmetadb'] as const).filter((service) => hasCredential(config, service));
    await enqueueTrackerWrites(userUUID, config, services.map((service) => ({
      service, op: 'clearResume', item: session.descriptor.i, coalesce: `resume:${session.videoId}`,
      payload: { type: session.stremioType, id: session.videoId },
    }))).catch((error: any) => logger.debug(`Clearing the resume point on trackers failed for ${session.videoId}: ${error?.message || error}`));
  }

  const database: any = require('../database');
  const row = await database.getPlaystate(userUUID, session.videoId, profile);
  return { played: Boolean(row?.played), positionMs };
}
