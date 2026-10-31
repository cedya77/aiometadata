import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { parseStremioId } from './idsCodec';
import { decodeJellyfinId, stremioIdFor } from './ids';
import { liveSessions, liveSessionsFor, type LiveSession } from './playstate';
import { syncStatus } from './playstateSync';
import { seenConfigurations } from './context';
import { seriesIndex } from './episodeIndex';
import { fetchMeta, isBoxSetMeta, parseRuntimeTicks, seriesStatus } from './items';
import { groupBySpelling } from './aliases';
import { itemIdForVideo } from './history';
import { defaultUserName, listProfiles, profileKey, scopeConfigToProfile } from './profiles';
import { CAPABLE, credentialFor } from './trackerSource';
import { isMatchable, trackerName, trackerOf, type Mark } from '../trackers';
import { sourceKeyFor } from './trackerMirror';
import { mapWithConcurrency } from '../../utils/concurrency';
import redis from '../redisClient';

const database: any = require('../database');

export interface PlayRow {
  profile: string;
  profileKey: string;
  videoId: string;
  itemId: string;
  imageUrl: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  title: string;
  episode: string | null;
  seriesId: string | null;
  season: number | null;
  number: number | null;
  episodeTitle: string | null;
  positionMs: number;
  runtimeMs: number;
  played: boolean;
  lastPlayedAt: number | null;
  watchedAt: number | null;
  rewatch: boolean;
  updatedAt: number;
}

export interface SessionRow {
  profile: string;
  profileKey: string;
  /** The profile signed in, when it plays into another profile's history. */
  viewer: string | null;
  imageUrl: string | null;
  backdropUrl: string | null;
  title: string;
  episode: string | null;
  positionMs: number;
  runtimeMs: number;
  paused: boolean;
  at: number;
}

const titles = new LRUCache<string, Named>({
  max: 5000,
  ttl: envInt('JELLYFIN_DASHBOARD_TITLE_TTL', 24 * 60 * 60, 60) * 1000,
});

interface Named {
  /** Every identity the play answers to: its id spellings, the meta's ids, the episode it located. */
  keys: string[];
  title: string;
  episode: string | null;
  imageUrl: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  seriesId: string | null;
  season: number | null;
  number: number | null;
  episodeTitle: string | null;
  runtimeMs: number;
}

async function withDeadline<T, F = null>(work: Promise<T>, onTimeout: F = null as F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<F>((resolve) => { timer = setTimeout(() => resolve(onTimeout), envInt('JELLYFIN_DASHBOARD_DESCRIBE_MS', 1500, 100)); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const runtimeMsOf = (runtime: unknown): number => Math.round((parseRuntimeTicks(runtime) ?? 0) / 10_000);

// The meta's own images: an episode's still and its show's poster, a film's backdrop and poster.
async function describe(userUUID: string, videoId: string): Promise<Named> {
  const key = `${userUUID}:${videoId}`;
  const held = titles.get(key);
  if (held) return held;

  const parsed = parseStremioId(videoId);
  let out: Named = { keys: [videoId], title: videoId, episode: null, imageUrl: null, posterUrl: null, backdropUrl: null, seriesId: null, season: null, number: null, episodeTitle: null, runtimeMs: 0 };
  try {
    if (parsed && parsed.episode !== null && parsed.episode !== undefined) {
      const index = (await seriesIndex(userUUID, parsed.base, { held: true }))
        ?? (await withDeadline(seriesIndex(userUUID, parsed.base)));
      const video = index?.videos.find((v) => v.id === videoId)
        ?? index?.videos.find((v) => v.episode === parsed.episode && (parsed.season === null ? v.season === null : v.season === parsed.season));
      const number = parsed.season === null || parsed.season === undefined ? `E${parsed.episode}` : `S${parsed.season}E${parsed.episode}`;
      const { videoIdAliases } = require('./aliases');
      const keys = [videoId, ...(await videoIdAliases(videoId))];
      if (video?.id) keys.push(video.id, ...(await videoIdAliases(video.id)));
      out = {
        keys,
        title: index?.name ?? videoId,
        episode: video?.title ? `${number} ${video.title}` : number,
        imageUrl: video?.thumbnail ?? index?.background ?? null,
        posterUrl: index?.poster ?? null,
        backdropUrl: index?.background ?? null,
        seriesId: index?.id ?? parsed.base,
        season: parsed.season ?? null,
        number: parsed.episode,
        episodeTitle: video?.title ?? null,
        runtimeMs: runtimeMsOf(video?.runtime),
      };
    } else if (parsed) {
      const meta = await withDeadline(fetchMeta(userUUID, 'movie', parsed.base));
      const keys = [videoId];
      for (const id of [meta?.id, meta?._imdbId, meta?.imdb_id, meta?._tmdbId && `tmdb:${meta._tmdbId}`]) if (id) keys.push(String(id));
      out = {
        keys,
        title: meta?.name ?? videoId,
        episode: null,
        imageUrl: meta?.background ?? meta?.poster ?? null,
        posterUrl: meta?.poster ?? null,
        backdropUrl: meta?.background ?? null,
        seriesId: null,
        season: null,
        number: null,
        episodeTitle: null,
        runtimeMs: runtimeMsOf(meta?.runtime),
      };
    }
  } catch {
    // The id stands in for the name.
  }
  if (out.title !== videoId) titles.set(key, out);
  return out;
}

function profileNames(config: any, userUUID: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const profile of listProfiles(config, userUUID)) names.set(profile.id ?? '', profile.name);
  return names;
}

// A profile that writes to the trackers plays into the account's history, under the main key.
function historyProfiles(config: any, userUUID: string): Array<{ key: string; name: string; sharedWith: string[] }> {
  const out: Array<{ key: string; name: string; sharedWith: string[] }> = [];
  for (const profile of listProfiles(config, userUUID)) {
    if (profile.id && profile.sharesHistory) out[0]?.sharedWith.push(profile.name);
    else out.push({ key: profile.id ?? '', name: profile.name, sharedWith: [] });
  }
  return out;
}

function historyKeyOf(config: any, userUUID: string, profile: string | null): string | null {
  if (profile === null) return null;
  const found = listProfiles(config, userUUID).find((p) => (p.id ?? '') === profile);
  return found?.id && found.sharesHistory ? '' : profile;
}

const profileLabel = (names: Map<string, string>, key: string): string =>
  names.get(key) ?? (key ? key.slice(0, 8) : 'Main');

function sameViewingMs(runtimeMs: number): number {
  return runtimeMs > 0 ? runtimeMs / 2 : envInt('JELLYFIN_REWATCH_MIN_GAP_MINUTES', 10, 0) * 60_000;
}

async function playRows(userUUID: string, rows: any[], names: Map<string, string>): Promise<PlayRow[]> {
  const described = await mapWithConcurrency(rows, envInt('JELLYFIN_DASHBOARD_DESCRIBE_CONCURRENCY', 8, 1), (row: any) => describe(userUUID, String(row.video_id)));
  const seen = new Map<string, PlayRow[]>();
  const out: PlayRow[] = [];
  rows.forEach((row, i) => {
    const videoId = String(row.video_id);
    const named = described[i];
    const watchedAt = row.watched_at ? Number(row.watched_at) : null;
    const keys = named.keys.map((id) => `${row.profile}|${id}`);
    const earlier = Number(row.earlier) > 0;
    const within = sameViewingMs(Number(row.runtime_ms) || 0);
    const held = keys.flatMap((key) => seen.get(key) ?? [])
      .find((entry) => watchedAt === null || entry.watchedAt === null || Math.abs(entry.watchedAt - watchedAt) < within);
    if (held) {
      if (earlier) held.rewatch = true;
      return;
    }
    const played = Boolean(row.played);
    const positionMs = Number(row.position_ms) || 0;
    const entry: PlayRow = {
      profile: profileLabel(names, String(row.profile ?? '')),
      profileKey: String(row.profile ?? ''),
      videoId,
      itemId: itemIdForVideo(videoId),
      imageUrl: named.imageUrl,
      posterUrl: named.posterUrl,
      backdropUrl: named.backdropUrl,
      title: named.title,
      episode: named.episode,
      seriesId: named.seriesId,
      season: named.season,
      number: named.number,
      episodeTitle: named.episodeTitle,
      positionMs,
      runtimeMs: Number(row.runtime_ms) || named.runtimeMs,
      played,
      lastPlayedAt: row.last_played_at ? Number(row.last_played_at) : null,
      watchedAt,
      rewatch: watchedAt ? earlier : played && positionMs > 0,
      updatedAt: Number(row.updated_at) || 0,
    };
    for (const key of keys) seen.set(key, [...(seen.get(key) ?? []), entry]);
    out.push(entry);
  });
  return out;
}
async function sessionRows(userUUID: string, names: Map<string, string>): Promise<SessionRow[]> {
  const own = await liveSessionsFor(userUUID);
  return mapWithConcurrency(own, 2, async (s) => {
    const descriptor = await decodeJellyfinId(s.itemId);
    const videoId = descriptor ? stremioIdFor(descriptor) : null;
    const named: Named = videoId ? await describe(userUUID, videoId) : { keys: [s.itemId], title: s.itemId, episode: null, imageUrl: null, posterUrl: null, backdropUrl: null, seriesId: null, season: null, number: null, episodeTitle: null, runtimeMs: 0 };
    const viewer = s.viewer && s.viewer !== s.profile ? names.get(s.viewer) ?? s.viewer.slice(0, 8) : null;
    const held = videoId ? await database.getPlaystate(userUUID, videoId, s.profile).catch(() => null) : null;
    return { profile: profileLabel(names, s.profile), profileKey: s.profile, viewer, imageUrl: named.imageUrl, backdropUrl: named.backdropUrl, title: named.title, episode: named.episode, positionMs: s.positionMs, runtimeMs: Number(held?.runtime_ms) || named.runtimeMs, paused: s.paused, at: s.at };
  });
}

let overviewMemo: { at: number; value: any } | null = null;

/** Instance signals that cost nothing that grows with the table. */
export async function dashboardOverview(): Promise<any> {
  const ttl = envInt('JELLYFIN_DASHBOARD_TOTALS_TTL', 60, 1) * 1000;
  const now = Date.now();
  const sessions = await liveSessions();
  if (overviewMemo && now - overviewMemo.at < ttl) {
    return { ...overviewMemo.value, ...liveCounts(sessions, now), sync: syncStatus() };
  }
  const [playedDay, playedWeek, seen] = await Promise.all([
    database.countWatchesSince(now - 24 * 60 * 60 * 1000),
    database.countWatchesSince(now - 7 * 24 * 60 * 60 * 1000),
    seenConfigurations(),
  ]);
  const value = {
    playedDay,
    playedWeek,
    activeConfigurations: seen ? seen.length : null,
    activeDays: envInt('JELLYFIN_ACTIVE_DAYS', 7, 1),
  };
  overviewMemo = { at: now, value };
  return { ...value, ...liveCounts(sessions, now), sync: syncStatus() };
}

function liveCounts(sessions: LiveSession[], now: number): { playingNow: number; pausedNow: number; sessions: number } {
  const window = envInt('JELLYFIN_DASHBOARD_LIVE_SECONDS', 120, 10) * 1000;
  const fresh = sessions.filter((s) => now - s.at <= window);
  return {
    playingNow: fresh.filter((s) => !s.paused).length,
    pausedNow: fresh.filter((s) => s.paused).length,
    sessions: sessions.length,
  };
}

export interface SearchRow {
  userUUID: string;
  label: string;
  profiles: Array<{ key: string; name: string }>;
  lastActivity: number | null;
}

/** Configurations matching an id prefix, or a user name among the active ones. */
export async function dashboardSearch(query: string): Promise<{ query: string; results: SearchRow[] }> {
  const limit = envInt('JELLYFIN_DASHBOARD_SEARCH_LIMIT', 30, 1);
  const q = query.trim();
  if (!q) return { query: q, results: [] };

  const candidates = new Set<string>();
  if (/^[0-9a-f-]{2,36}$/i.test(q)) {
    for (const uuid of await database.findUserUUIDsByPrefix(q.toLowerCase(), limit)) candidates.add(uuid);
  }
  if (candidates.size === 0) {
    const needle = q.toLowerCase();
    const seen = ((await seenConfigurations()) ?? []).slice(0, envInt('JELLYFIN_DASHBOARD_NAME_SCAN_MAX', 200, 1));
    const matched = await mapWithConcurrency(seen, envInt('JELLYFIN_DASHBOARD_SEARCH_CONCURRENCY', 8, 1), async (uuid: string) => {
      const config = await database.getUserConfig(uuid).catch(() => null);
      return config && listProfiles(config, uuid).some((p) => p.name.toLowerCase().includes(needle)) ? uuid : null;
    });
    for (const uuid of matched) if (uuid && candidates.size < limit) candidates.add(uuid);
  }

  const results = (await mapWithConcurrency([...candidates].slice(0, limit), 4, async (uuid: string): Promise<SearchRow | null> => {
    const config = await database.getUserConfig(uuid).catch(() => null);
    if (!config) return null;
    const byProfile: any[] = await database.playstateForConfiguration(uuid);
    const lastActivity = byProfile.reduce((at: number, p: any) => Math.max(at, Number(p.last_played_at) || 0, Number(p.updated_at) || 0), 0) || null;
    return { userUUID: uuid, label: defaultUserName(config, uuid), profiles: [...profileNames(config, uuid).entries()].map(([key, name]) => ({ key, name })), lastActivity };
  })).filter((r): r is SearchRow => r !== null);
  return { query: q, results: results.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)) };
}

interface ProfileStats {
  played: number;
  inProgress: number;
  movies: number;
  episodes: number;
  days: Record<string, number>;
}

const ACTIVITY_DAYS = 371;

const statsMemo = new LRUCache<string, { fingerprint: string; work: Promise<Map<string, ProfileStats>> }>({
  max: 200,
  ttl: envInt('JELLYFIN_DASHBOARD_STATS_TTL', 120, 10) * 1000,
});
const statsRefreshing = new Set<string>();

function statsFingerprint(summary: any[]): string {
  return summary
    .map((row) => `${row.profile ?? ''}:${Number(row.rows_total) || 0}:${Number(row.in_progress) || 0}:${Number(row.played) || 0}:${Number(row.last_played_at) || 0}:${Number(row.updated_at) || 0}`)
    .sort()
    .join('|');
}

const statsStoreKey = (key: string) => `jf:dashstats:v3:${key}`;

async function storedStats(key: string): Promise<{ fingerprint: string; stats: Map<string, ProfileStats> } | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(statsStoreKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { fingerprint: String(parsed.fingerprint), stats: new Map(parsed.stats) };
  } catch {
    return null;
  }
}

async function computeStats(userUUID: string, offsetMinutes: number, fingerprint: string): Promise<Map<string, ProfileStats>> {
  const key = `${userUUID}:${offsetMinutes}`;
  const stats = await readProfileStats(userUUID, offsetMinutes);
  if (redis) {
    const seconds = envInt('JELLYFIN_DASHBOARD_STATS_KEEP_DAYS', 30, 1) * 24 * 60 * 60;
    redis.set(statsStoreKey(key), JSON.stringify({ fingerprint, stats: [...stats.entries()] }), 'EX', seconds).catch(() => undefined);
  }
  return stats;
}

export async function forgetDashboardStats(userUUID: string): Promise<void> {
  for (const key of [...statsMemo.keys()]) if (key.startsWith(`${userUUID}:`)) statsMemo.delete(key);
  if (!redis) return;
  const keys = Array.from({ length: 14 * 60 * 2 + 1 }, (_, i) => statsStoreKey(`${userUUID}:${i - 14 * 60}`));
  await redis.del(...keys).catch(() => undefined);
}

function profileStats(userUUID: string, offsetMinutes: number, summary: any[]): Promise<Map<string, ProfileStats>> {
  const key = `${userUUID}:${offsetMinutes}`;
  const fingerprint = statsFingerprint(summary);
  const held = statsMemo.get(key);
  if (held && held.fingerprint === fingerprint) return held.work;
  const work = (async () => {
    const stored = await storedStats(key);
    if (stored && stored.fingerprint === fingerprint) return stored.stats;
    if (!stored) return computeStats(userUUID, offsetMinutes, fingerprint);
    if (!statsRefreshing.has(key)) {
      statsRefreshing.add(key);
      computeStats(userUUID, offsetMinutes, fingerprint)
        .then((fresh) => statsMemo.set(key, { fingerprint, work: Promise.resolve(fresh) }))
        .catch(() => undefined)
        .finally(() => statsRefreshing.delete(key));
    }
    return stored.stats;
  })();
  statsMemo.set(key, { fingerprint, work });
  work.catch(() => statsMemo.delete(key));
  return work;
}

/** Each history's titles played and in progress, a title's spellings counted once, and its latest play. */
export async function playCounts(userUUID: string): Promise<Map<string, { played: number; movies: number; episodes: number; inProgress: number; lastAt: number | null }>> {
  const byProfile: any[] = await database.playstateForConfiguration(userUUID);
  const stats = await profileStats(userUUID, 0, byProfile);
  return new Map(byProfile.map((row: any) => {
    const key = String(row.profile ?? '');
    const titles = stats.get(key);
    return [key, {
      played: titles?.played ?? 0,
      movies: titles?.movies ?? 0,
      episodes: titles?.episodes ?? 0,
      inProgress: titles?.inProgress ?? 0,
      lastAt: Number(row.last_played_at) || null,
    }];
  }));
}

async function readProfileStats(userUUID: string, offsetMinutes: number): Promise<Map<string, ProfileStats>> {
  const rows: any[] = await database.watchedRowsForConfiguration(userUUID);
  const byProfile = new Map<string, any[]>();
  for (const row of rows) {
    const key = String(row.profile ?? '');
    if (!byProfile.has(key)) byProfile.set(key, []);
    byProfile.get(key)!.push(row);
  }
  const since = Date.now() - ACTIVITY_DAYS * 24 * 60 * 60 * 1000;
  const watches = new Map<string, number[]>();
  for (const watch of await database.listWatchesSince(userUUID, since)) {
    const key = `${watch.profile}|${watch.video_id}`;
    watches.set(key, [...(watches.get(key) ?? []), watch.watched_at]);
  }
  const dayOf = (at: number) => new Date(at - offsetMinutes * 60_000).toISOString().slice(0, 10);
  const out = new Map<string, ProfileStats>();
  for (const [profile, list] of byProfile) {
    const stats: ProfileStats = { played: 0, inProgress: 0, movies: 0, episodes: 0, days: {} };
    const watchedMs = envInt('JELLYFIN_DASHBOARD_WATCHED_MINUTES', 5, 1) * 60_000;
    for (const group of await groupBySpelling(list)) {
      if (group.some((row) => Number(row.position_ms) > 0)) stats.inProgress += 1;
      const played = group.some((row) => Number(row.played) === 1);
      if (played) {
        stats.played += 1;
        const parsed = parseStremioId(String(group[0].video_id));
        if (parsed?.episode !== null && parsed?.episode !== undefined) stats.episodes += 1;
        else stats.movies += 1;
      }
      const finishes = new Set(group.flatMap((row) => watches.get(`${profile}|${row.video_id}`) ?? []));
      for (const at of finishes) stats.days[dayOf(at)] = (stats.days[dayOf(at)] ?? 0) + 1;
      if (!group.some((row) => Number(row.position_ms) >= watchedMs)) continue;
      const at = group.reduce((max, row) => Math.max(max, Number(row.last_played_at) || 0), 0);
      if (at < since || finishes.has(at)) continue;
      stats.days[dayOf(at)] = (stats.days[dayOf(at)] ?? 0) + 1;
    }
    out.set(profile, stats);
  }
  return out;
}

export interface SyncRow {
  service: string;
  profiles: string[];
  syncedAt: number | null;
  fullAt: number | null;
  imported: boolean;
  pending: number;
  oldestPendingAt: number | null;
  attempts: number;
  lastError: string | null;
  readError: string | null;
}

type SyncSource = { service: string; profiles: string[]; keys: Set<string>; credential: string; scoped: any };

function syncSources(config: any, userUUID: string, only: string | null = null): Map<string, SyncSource> {
  const sources = new Map<string, SyncSource>();
  for (const profile of historyProfiles(config, userUUID)) {
    if (only !== null && profile.key !== only) continue;
    const scoped = { ...scopeConfigToProfile(config, userUUID, profile.key || null), userUUID };
    for (const service of CAPABLE) {
      const credential = credentialFor(scoped, service);
      if (!credential) continue;
      const key = sourceKeyFor(service, credential);
      const source = sources.get(key) ?? { service, profiles: [], keys: new Set<string>(), credential, scoped };
      source.profiles.push(profile.name);
      source.keys.add(profile.key);
      sources.set(key, source);
    }
  }
  return sources;
}

async function trackerSync(config: any, userUUID: string): Promise<SyncRow[]> {
  const sources = syncSources(config, userUUID);
  const queued: any[] = await database.outboxForConfiguration(userUUID).catch(() => []);
  const reads: any[] = await database.listTrackerActivity([...sources.keys()], Date.now() - 2 * DAY_MS, 1000).catch(() => []);
  return mapWithConcurrency([...sources.entries()], 4, async ([key, source]): Promise<SyncRow> => {
    const lastRead = reads.find((row) => row.source_key === key && (row.kind === 'read' || row.kind === 'readFailed'));
    const state = await database.getTrackerSync(key).catch(() => null);
    const waiting = queued.filter((row) => row.service === source.service && source.keys.has(String(row.profile ?? '')));
    const failed = [...waiting].reverse().find((row) => row.last_error);
    return {
      service: source.service,
      profiles: source.profiles,
      syncedAt: Number(state?.synced_at) || null,
      fullAt: Number(state?.full_at) || null,
      imported: Number(state?.version) > 0,
      pending: waiting.length,
      oldestPendingAt: waiting.length ? Math.min(...waiting.map((row) => Number(row.created_at) || Date.now())) : null,
      attempts: waiting.reduce((max, row) => Math.max(max, Number(row.attempts) || 0), 0),
      lastError: failed ? String(failed.last_error) : null,
      readError: lastRead?.kind === 'readFailed' ? String(parseDetail(lastRead.detail).error ?? 'The last read failed') : null,
    };
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const QUIET_VERBS = new Set(['Started watching', 'Paused']);

const parseDetail = (value: unknown): Record<string, any> => {
  try {
    return value ? JSON.parse(String(value)) : {};
  } catch {
    return {};
  }
};

export async function dashboardSync(userUUID: string, viewer: string | null): Promise<any | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  if (!config) return null;
  const profile = historyKeyOf(config, userUUID, viewer);
  const sources = syncSources(config, userUUID, profile);
  const keys = [...sources.keys()];
  const now = Date.now();
  const { summariseJob } = require('../trackerActivity');
  const [waitingByLane, activity, states] = await Promise.all([
    Promise.all(keys.map((key) => database.outboxRowsForLane(userUUID, sources.get(key)!.service, [...sources.get(key)!.keys]).catch(() => ({ rows: [], total: 0 })))),
    database.listTrackerActivity(keys, now - envInt('JELLYFIN_TRACKER_ACTIVITY_DAYS', 14, 1) * DAY_MS).catch(() => []),
    Promise.all(keys.map((key) => database.getTrackerSync(key).catch(() => null))),
  ]);
  const queued = waitingByLane.flatMap((lane: any) => lane.rows);
  const waitingIn = new Map<string, number>(keys.map((key, i) => [key, waitingByLane[i].total]));
  const laneOf = (service: string, profileKeyOfRow: string) => keys.find((key) => sources.get(key)!.service === service && sources.get(key)!.keys.has(profileKeyOfRow));

  const writes = (queued as any[]).map((row) => {
    let payload: any = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {}
    const job = summariseJob(row.op, payload, row.item_key);
    return {
      id: Number(row.id),
      lane: laneOf(String(row.service), String(row.profile ?? '')),
      service: String(row.service),
      op: String(row.op),
      verb: job.verb,
      count: job.count,
      video: job.video,
      attempts: Number(row.attempts) || 0,
      createdAt: Number(row.created_at) || now,
      nextAt: Number(row.next_at) || now,
      sending: Number(row.claimed_until) > now,
      lastError: row.last_error ? String(row.last_error) : null,
    };
  }).filter((write) => write.lane);

  const events = (activity as any[]).map((row) => ({ ...row, at: Number(row.at), detail: parseDetail(row.detail) }));
  const feedRows = events.filter((row) => row.user_uuid === userUUID && ['sent', 'failed', 'dropped'].includes(row.kind) && !QUIET_VERBS.has(row.detail.verb)
    && (profile === null || String(row.profile ?? '') === profile));
  const feed: any[] = [];
  for (const row of feedRows) {
    const held = feed.find((entry) => entry.video === row.video && entry.verb === row.detail.verb && Math.abs(entry.at - row.at) < 2 * 60 * 1000);
    const mark = { service: String(row.service), lane: String(row.source_key), kind: String(row.kind), reason: row.detail.reason ?? null };
    if (held) {
      if (!held.services.some((s: any) => s.lane === mark.lane)) held.services.push(mark);
      continue;
    }
    if (feed.length >= envInt('JELLYFIN_DASHBOARD_SYNC_FEED', 60, 10)) continue;
    feed.push({ at: row.at, verb: String(row.detail.verb ?? row.op ?? ''), count: Number(row.detail.count) || 1, video: row.video ? String(row.video) : null, services: [mark] });
  }

  const videos = [...new Set([...writes.map((w) => w.video), ...feed.map((f) => f.video)].filter(Boolean) as string[])].slice(0, 120);
  const named = new Map<string, Named | null>();
  await mapWithConcurrency(videos, envInt('JELLYFIN_DASHBOARD_DESCRIBE_CONCURRENCY', 8, 1), async (video: string) => {
    named.set(video, await withDeadline(describe(userUUID, video).catch(() => null)));
  });
  const label = (video: string | null) => {
    const n = video ? named.get(video) : null;
    return { title: n?.title && n.title !== video ? n.title : null, episode: n?.episode ?? null, imageUrl: n?.imageUrl ?? n?.backdropUrl ?? null };
  };

  const lanes = keys.map((key, i) => {
    const source = sources.get(key)!;
    const state: any = states[i];
    const mine = events.filter((row) => row.source_key === key);
    const lastRead = mine.find((row) => row.kind === 'read');
    const lastReadFailure = mine.find((row) => row.kind === 'readFailed');
    const day = mine.filter((row) => row.at >= now - DAY_MS);
    const waiting = writes.filter((w) => w.lane === key);
    return {
      key,
      service: source.service,
      profiles: source.profiles,
      syncedAt: Number(state?.synced_at) || null,
      fullAt: Number(state?.full_at) || null,
      imported: Number(state?.version) > 0,
      readError: lastReadFailure && (!lastRead || lastReadFailure.at > lastRead.at) ? String(lastReadFailure.detail.error ?? '') : null,
      pending: Math.max(waitingIn.get(key) ?? 0, waiting.length),
      nextTryAt: waiting.length ? Math.min(...waiting.map((w) => w.nextAt)) : null,
      lastError: [...waiting].reverse().find((w) => w.lastError)?.lastError ?? null,
      sent: day.filter((row) => row.kind === 'sent').length,
      failed: day.filter((row) => row.kind === 'failed').length,
      pulse: day.slice(0, 400).map((row) => ({ at: row.at, kind: row.kind, verb: row.detail.verb ?? null, video: row.video ?? null, reason: row.detail.reason ?? row.detail.error ?? null, changed: row.detail.changed ?? null, full: row.detail.full ?? null })),
    };
  });

  return {
    now,
    lanes,
    queue: writes.map((w) => ({ ...w, ...label(w.video) })),
    feed: feed.map((f) => ({ ...f, ...label(f.video) })),
  };
}

export async function dashboardSyncNow(userUUID: string, key: string, full: boolean): Promise<{ ms: number; changed: boolean } | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  const source = config ? syncSources(config, userUUID).get(key) : null;
  if (!source) return null;
  const { syncMirror } = require('./trackerMirror');
  const before = Number((await database.getTrackerSync(key).catch(() => null))?.version) || 0;
  const started = Date.now();
  const version = await syncMirror(source.service, source.credential, source.scoped, { full, fresh: true });
  forgetDrift(userUUID);
  return { ms: Date.now() - started, changed: version !== before };
}

export async function dashboardOutbox(userUUID: string, action: 'retry' | 'drop', ids: number[]): Promise<number | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  if (!config) return null;
  forgetDrift(userUUID);
  if (action === 'retry') {
    const hurried = await database.hurryTrackerOutbox(userUUID, ids);
    require('../trackerOutbox').wakeTrackerOutbox();
    return hurried;
  }
  const dropped: any[] = await database.dropTrackerOutbox(userUUID, ids);
  const { noteActivity, summariseJob } = require('../trackerActivity');
  for (const row of dropped) {
    const credential = credentialFor(scopeConfigToProfile(config, userUUID, row.profile || null), row.service);
    if (!credential) continue;
    let payload: any = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {}
    const job = summariseJob(row.op, payload, row.item_key);
    await noteActivity({ sourceKey: sourceKeyFor(row.service, credential), service: row.service, kind: 'dropped', userUUID, profile: row.profile ?? '', op: row.op, video: job.video, detail: { verb: job.verb, count: job.count, reason: 'Dropped from the dashboard' } });
    await require('../trackerOutbox').unlayer(row, scopeConfigToProfile(config, userUUID, row.profile || null));
  }
  return dropped.length;
}

const drifts = new LRUCache<string, any>({ max: 200, ttl: envInt('JELLYFIN_TRACKER_DRIFT_CACHE_SECONDS', 60, 0) * 1000 || 1 });

const driftEpochs = new Map<string, number>();

function forgetDrift(userUUID: string): void {
  driftEpochs.set(userUUID, (driftEpochs.get(userUUID) ?? 0) + 1);
  for (const key of [...drifts.keys()]) if (key.startsWith(`${userUUID}|`)) drifts.delete(key);
}

async function driftOf(userUUID: string, key: string, source: SyncSource): Promise<any> {
  const { driftFor } = require('./trackerDrift');
  return driftFor(userUUID, { service: source.service, credential: source.credential, keys: source.keys, scoped: source.scoped });
}

async function driftOutcomes(key: string): Promise<Map<string, string | null>> {
  const { driftWindowDays } = require('./trackerDrift');
  const outcomes = new Map<string, string | null>();
  for (const row of (await database.listTrackerActivity([key], Date.now() - driftWindowDays() * DAY_MS, 2000).catch(() => [])) as any[]) {
    if (!row.video || (row.kind !== 'sent' && row.kind !== 'failed')) continue;
    let detail: any = {};
    try {
      detail = JSON.parse(row.detail ?? '{}');
    } catch {}
    const outcome = row.kind === 'failed' && (detail.status === 404 || detail.status === 422) ? String(detail.reason ?? 'not found') : null;
    for (const video of [String(row.video), ...(Array.isArray(detail.videos) ? detail.videos.map(String) : [])]) {
      if (!outcomes.has(video)) outcomes.set(video, outcome);
    }
  }
  return outcomes;
}

async function driftItems(userUUID: string, source: SyncSource, outcomes: Map<string, string | null>, viewings: any[]): Promise<any[]> {
  const { spellingFor } = require('./trackerDrift');
  const { parseStremioId } = require('./idsCodec');
  const { matchFor } = require('./trackerMatch');
  const groups = new Map<string, any[]>();
  for (const v of viewings) {
    const id = `${v.profile}|${v.metaId}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(v);
  }
  const out = await mapWithConcurrency([...groups.entries()], envInt('JELLYFIN_DASHBOARD_DESCRIBE_CONCURRENCY', 8, 1), async ([id, list]) => {
    list.sort((a: any, b: any) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || a.at - b.at);
    const spelling = spellingFor(source.service, list[list.length - 1].ids);
    const named = await withDeadline(describe(userUUID, spelling).catch(() => null));
    const bases = [...new Set(list.flatMap((v: any) => v.ids.map((video: string) => parseStremioId(video)?.base ?? video)))] as string[];
    const matchable = isMatchable(source.service);
    const matched = matchable ? (await Promise.all(bases.map((base) => matchFor(userUUID, source.service, base)))).find(Boolean) ?? null : null;
    return {
      id,
      kind: list[0].kind,
      video: spelling,
      bases,
      ...(matchable ? {
        seasons: [...new Set(list.map((v: any) => v.season).filter((season: any) => Number.isFinite(season)))].sort((a: any, b: any) => a - b),
        unmatched: list.flatMap((v: any) => v.ids).map((video: string) => outcomes.get(video)).find(Boolean) ?? null,
        matchedTo: matched ? matched.target.title : null,
      } : {}),
      title: named && named.title !== spelling ? named.title : null,
      open: list[0].kind === 'movie'
        ? { id: list[0].ids.find((id: string) => id.startsWith('tt')) ?? list[0].metaId, type: 'movie' }
        : { id: named?.seriesId ?? list[0].metaId, type: 'series' },
      imageUrl: named?.backdropUrl ?? named?.imageUrl ?? named?.posterUrl ?? null,
      views: list.map((v: any) => ({ at: v.at, season: v.season, episode: v.episode, video: v.ids[0], ...(v.theirs ? { theirs: v.theirs } : {}) })),
      lastAt: Math.max(...list.map((v: any) => v.at)),
    };
  });
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

async function importGroups(userUUID: string, source: SyncSource, outcomes: Map<string, string | null>, drift: any): Promise<any[]> {
  const names: Map<string, string> = require('./historyTransfer').importedOrigins();
  const groups = [];
  for (const [origin, name] of names) {
    const list = drift.imported.filter((v: any) => v.origin === origin);
    const left = drift.leftOut[origin] ?? 0;
    if (!list.length && !left) continue;
    const titles = [...new Set(list.map((v: any) => `${v.profile}|${v.metaId}`))];
    const newest = [...list].sort((a: any, b: any) => b.at - a.at);
    const shown = new Set(newest.map((v: any) => `${v.profile}|${v.metaId}`).filter((id: string, i: number, all: string[]) => all.indexOf(id) === i).slice(0, 4));
    const preview = await driftItems(userUUID, source, outcomes, list.filter((v: any) => shown.has(`${v.profile}|${v.metaId}`)));
    groups.push({
      origin,
      name,
      plays: list.length,
      titles: titles.length,
      undated: list.filter((v: any) => !v.at).length,
      left,
      preview: preview.map((item) => ({ id: item.id, title: item.title, imageUrl: item.imageUrl })),
    });
  }
  return groups;
}

export async function dashboardDrift(userUUID: string, viewer: string | null): Promise<any | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  if (!config) return null;
  const profile = historyKeyOf(config, userUUID, viewer);
  const memoKey = `${userUUID}|${profile ?? '*'}`;
  const held = drifts.get(memoKey);
  if (held) return held;
  const epoch = driftEpochs.get(userUUID) ?? 0;
  const { driftWindowDays } = require('./trackerDrift');
  const sources = syncSources(config, userUUID, profile);
  const lanes = await mapWithConcurrency([...sources.entries()], 2, async ([key, source]) => {
    try {
      const drift = await driftOf(userUUID, key, source);
      const outcomes = await driftOutcomes(key);
      const items = (viewings: any[]) => driftItems(userUUID, source, outcomes, viewings);
      const rewatchNote = drift.rewatched.length && !(await keepsRewatches(source)) ? 'free' : null;
      return { key, behind: await items(drift.behind), imported: await importGroups(userUUID, source, outcomes, drift), ahead: await items(drift.ahead), rewatched: await items(drift.rewatched), rewatchNote, unread: drift.unread, readAt: drift.readAt, error: null };
    } catch (error: any) {
      return { key, behind: [], imported: [], ahead: [], rewatched: [], rewatchNote: null, unread: 0, readAt: null, error: String(error?.message || error).slice(0, 200) };
    }
  });
  const out = { checkedAt: Date.now(), days: driftWindowDays(), lanes };
  if ((driftEpochs.get(userUUID) ?? 0) === epoch) drifts.set(memoKey, out);
  return out;
}

export async function dashboardDriftImported(userUUID: string, key: string, origin: string, viewer: string | null): Promise<any[] | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  const source = config ? syncSources(config, userUUID, historyKeyOf(config, userUUID, viewer)).get(key) : null;
  if (!source) return null;
  const drift = await driftOf(userUUID, key, source);
  return driftItems(userUUID, source, await driftOutcomes(key), drift.imported.filter((v: any) => v.origin === origin));
}

function keepsRewatches(source: SyncSource): Promise<boolean> {
  return require('./trackerDrift').keepsRewatches(source);
}

export async function dashboardDriftAction(userUUID: string, key: string, action: 'push' | 'pull' | 'leave' | 'restore', items: string[] | null, origin: string | null = null, viewer: string | null = null): Promise<number | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  const source = config ? syncSources(config, userUUID, historyKeyOf(config, userUUID, viewer)).get(key) : null;
  if (!source) return null;
  if (action === 'restore') {
    const restored = origin ? await database.restoreLeftOut(userUUID, key, origin, [...source.keys]) : 0;
    forgetDrift(userUUID);
    return restored;
  }
  const { pushDrift, pullDrift } = require('./trackerDrift');
  if (action === 'push') await require('./trackerMirror').syncMirror(source.service, source.credential, source.scoped);
  const drift = await driftOf(userUUID, key, source);
  const wanted = (v: any) => !items || items.includes(`${v.profile}|${v.metaId}`);
  // Imported plays go out only from their own group, where the user chose to send them.
  const brought = origin ? drift.imported.filter((v: any) => v.origin === origin) : [];
  if (action === 'leave') {
    const leaving = origin ? brought.filter(wanted) : [];
    if (leaving.length) await database.leaveOut(userUUID, key, origin, leaving.flatMap((v: any) => v.ids.map((videoId: string) => ({ profile: v.profile, videoId }))));
    forgetDrift(userUUID);
    return leaving.length;
  }
  const driftSource = { service: source.service, credential: source.credential, keys: source.keys, scoped: source.scoped };
  const again = action === 'push' && !origin && drift.rewatched.length && await keepsRewatches(source) ? drift.rewatched.filter(wanted) : [];
  const done = action === 'push'
    ? await pushDrift(userUUID, config, driftSource, [...(origin ? [] : drift.behind), ...brought].filter(wanted), again)
    : await pullDrift(userUUID, driftSource, drift.ahead.filter(wanted));
  forgetDrift(userUUID);
  if (action === 'pull') {
    forgetMemos(userUUID);
    require('./resume').invalidateResume(userUUID);
  }
  return done;
}

export async function dashboardDriftItem(userUUID: string, key: string, side: 'behind' | 'ahead', video: string, bases: string[]): Promise<any | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  const source = config ? syncSources(config, userUUID).get(key) : null;
  const { parseStremioId } = require('./idsCodec');
  const parsed = parseStremioId(video);
  const shows = bases.filter((base) => parseStremioId(base)?.base === base).slice(0, 20);
  if (!source || !parsed || !shows.length) return null;
  const { driftWindowDays } = require('./trackerDrift');
  const { videoIdAliases } = require('./aliases');
  const { matchFor } = require('./trackerMatch');
  const { indexedSnapshot, seriesCountsAmong, watchedAmong } = require('./watched');
  const { trackerConfig } = require('../accounts');

  const match = isMatchable(source.service)
    ? (await Promise.all(shows.map((base) => matchFor(userUUID, source.service, base)))).find(Boolean) ?? null
    : null;
  const aliases: string[] = await videoIdAliases(video).catch(() => []);

  let sendsAs: any = null;
  let sendError: string | null = null;
  const animeEntry = trackerOf(source.service)?.animeEntry;
  if (side === 'behind' && animeEntry) {
    const { parseMediaId } = require('../subtitleHandler');
    const media = parseMediaId(video);
    try {
      const target: any = media ? await withDeadline(animeEntry(media), 'slow') : null;
      const entry = target && target !== 'slow' ? target.id : null;
      if (target === 'slow') sendError = 'Working out the ids took too long; open this again';
      else if (entry) sendsAs = { ids: { [source.service]: entry }, season: null, episode: Number(target.episode) || null };
      else sendError = media ? `No ${trackerName(source.service)} entry is mapped to ${video}` : `${video} is not an id trackers take`;
    } catch (error: any) {
      sendError = String(error?.message || error).slice(0, 200);
    }
  } else if (side === 'behind') {
    const { parseMediaId, historyTarget } = require('../subtitleHandler');
    const media = parseMediaId(video);
    try {
      const target: any = media ? await withDeadline(historyTarget(media, { ...trackerConfig(source.scoped, source.service), userUUID }, source.service), 'slow') : null;
      if (target === 'slow') sendError = 'Working out the ids took too long; open this again';
      else if (target) sendsAs = { ids: target.ids, season: target.season ?? null, episode: target.episode ?? null };
      else if (match && media && (await require('./trackerMatch').unsentAmong(userUUID, source.service, [video])).has(video)) sendError = 'Its match sends nothing for this episode: an earlier part carries it, or the tracker does not have it';
      else sendError = media ? `No ${source.service} ids for ${video}` : `${video} is not an id trackers take`;
    } catch (error: any) {
      sendError = String(error?.message || error).slice(0, 200);
    }
  }

  const snapshot = await indexedSnapshot(source.service, source.credential, source.scoped).catch(() => null);
  const theirShows: string[] = match ? require('./trackerMatch').matchBases(match) : [];
  let holds: any = null;
  if (snapshot?.source) {
    if (parsed.episode === null || parsed.episode === undefined) {
      const held = await watchedAmong(snapshot, [...shows, ...theirShows]);
      holds = { kind: 'movie', watchedAt: held.size ? Math.max(...held.values()) || null : null, found: held.size > 0 };
    } else {
      const counts = await seriesCountsAmong(snapshot, [...shows, ...theirShows]);
      const best = [...counts.values()].sort((a: any, b: any) => b.watched - a.watched)[0] ?? null;
      const season = Number(parsed.season ?? 1);
      const theirSeason = match?.seasons?.[String(season)]?.season ?? season;
      const spellings = new Map<string, number>();
      const ourShows = [...new Set([...shows, ...aliases.map((alias) => parseStremioId(alias)?.base).filter(Boolean)])] as string[];
      // Long seasons run past 80, so the search reaches the episode asked about and the show's own count.
      const upTo = Math.min(1000, Math.max(80, Number(parsed.episode) || 0, Number(sendsAs?.episode) || 0, Number(best?.total) || 0));
      for (let episode = 1; episode <= upTo; episode += 1) {
        for (const base of ourShows) spellings.set(`${base}:${season}:${episode}`, episode);
        for (const base of theirShows) spellings.set(`${base}:${theirSeason}:${episode}`, episode);
      }
      const seen = await watchedAmong(snapshot, [...spellings.keys()]);
      const numbers = [...new Set([...seen.keys()].map((id) => spellings.get(id)!))].sort((a, b) => a - b);
      holds = { kind: 'series', found: Boolean(best), watched: best?.watched ?? 0, total: best?.total ?? 0, at: best?.at || null, season: theirSeason, numbers, upTo };
    }
  }

  const wanted = new Set(shows);
  const baseOf = (video: string): string => parseStremioId(video)?.base ?? video;
  const attempts = ((await database.listTrackerActivity([key], Date.now() - driftWindowDays() * DAY_MS, 2000).catch(() => [])) as any[])
    .filter((row) => row.video && (row.kind === 'sent' || row.kind === 'failed' || row.kind === 'dropped'))
    .map((row) => {
      let detail: any = {};
      try {
        detail = JSON.parse(row.detail ?? '{}');
      } catch {}
      const videos = [String(row.video), ...(Array.isArray(detail.videos) ? detail.videos.map(String) : [])];
      const video = videos.find((entry) => wanted.has(baseOf(entry)));
      return video ? { at: Number(row.at), kind: row.kind, video, verb: detail.verb ?? null, reason: detail.reason ?? null } : null;
    })
    .filter(Boolean)
    .slice(0, 6);

  return {
    service: source.service,
    side,
    video,
    aliases: aliases.filter((alias) => alias !== video).slice(0, 6),
    sendsAs,
    sendError,
    match: match ? { title: match.target.title, year: match.target.year, seasons: match.seasons } : null,
    holds,
    attempts,
  };
}

async function matchSource(userUUID: string, key: string): Promise<SyncSource | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  const source = config ? syncSources(config, userUUID).get(key) ?? null : null;
  return source && isMatchable(source.service) ? source : null;
}

const MATCH_ID_KEYS = new Set(['simkl', 'imdb', 'tvdb', 'tmdb']);

function cleanIds(value: any): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(value && typeof value === 'object' ? value : {})) {
    if (!MATCH_ID_KEYS.has(key)) continue;
    if (key === 'imdb') {
      if (typeof raw === 'string' && /^tt\d+$/.test(raw)) out.imdb = raw;
    } else if (Number.isInteger(Number(raw)) && Number(raw) > 0) {
      out[key] = Number(raw);
    }
  }
  return out;
}

function cleanCandidate(value: any): any | null {
  const ids = cleanIds(value?.ids);
  if (!Object.keys(ids).length) return null;
  const posterUrl = typeof value?.posterUrl === 'string' && /^https:\/\//.test(value.posterUrl) ? value.posterUrl.slice(0, 500) : null;
  return {
    ids,
    title: String(value?.title ?? '').slice(0, 200),
    year: Number.isInteger(Number(value?.year)) ? Number(value.year) : null,
    posterUrl,
    kind: ['tv', 'anime', 'movie'].includes(value?.kind) ? value.kind : 'tv',
    episodes: Number.isInteger(Number(value?.episodes)) ? Number(value.episodes) : null,
  };
}

export async function dashboardMatchSearch(userUUID: string, key: string, query: string, kind: 'movie' | 'series'): Promise<any[] | null> {
  const source = await matchSource(userUUID, key);
  if (!source) return null;
  const { searchTargets } = require('./trackerMatch');
  return searchTargets(source.service, source.credential, query, kind, source.scoped);
}

export async function dashboardMatchDetail(userUUID: string, key: string, candidate: any): Promise<any | null> {
  const source = await matchSource(userUUID, key);
  const picked = cleanCandidate(candidate);
  if (!source || !picked) return null;
  const { targetDetail } = require('./trackerMatch');
  return targetDetail(source.service, source.credential, picked, source.scoped);
}

export async function dashboardMatches(userUUID: string, key: string): Promise<any[] | null> {
  const source = await matchSource(userUUID, key);
  if (!source) return null;
  const { listMatches } = require('./trackerMatch');
  return listMatches(userUUID, source.service);
}

export async function dashboardMatchSave(userUUID: string, key: string, body: any): Promise<{ match: any; sent: number } | null> {
  const source = await matchSource(userUUID, key);
  const target = cleanCandidate(body?.target);
  const { parseStremioId } = require('./idsCodec');
  const bases = (Array.isArray(body?.bases) ? body.bases : [])
    .filter((base: unknown) => typeof base === 'string' && parseStremioId(base)?.base === base)
    .slice(0, 20);
  if (!source || !target || !bases.length) return null;
  const seasons: Record<string, { season: number; offset: number }> = {};
  for (const [ours, link] of Object.entries(body?.seasons && typeof body.seasons === 'object' ? body.seasons : {})) {
    const season = Number((link as any)?.season);
    const offset = Number((link as any)?.offset ?? 0);
    if (!/^\d{1,4}$/.test(ours) || !Number.isInteger(season) || season < 0 || season > 9999 || !Number.isInteger(offset) || Math.abs(offset) > 9999) continue;
    seasons[ours] = { season, offset };
  }
  const episodes: Record<string, { season: number; episode: number } | null> = {};
  for (const [ours, theirs] of Object.entries(body?.episodes && typeof body.episodes === 'object' ? body.episodes : {}).slice(0, 5000)) {
    if (!/^\d{1,4}:\d{1,5}$/.test(ours)) continue;
    if (theirs === null) {
      episodes[ours] = null;
      continue;
    }
    const season = Number((theirs as any)?.season);
    const episode = Number((theirs as any)?.episode);
    if (!Number.isInteger(season) || season < 0 || season > 9999 || !Number.isInteger(episode) || episode < 1 || episode > 99999) continue;
    episodes[ours] = { season, episode };
  }
  const { saveMatch } = require('./trackerMatch');
  const match = await saveMatch(userUUID, source.service, {
    bases,
    kind: body?.kind === 'movie' ? 'movie' : 'series',
    title: typeof body?.title === 'string' ? body.title.slice(0, 200) : null,
    open: typeof body?.open?.id === 'string' && body.open.id.length <= 100 ? { id: body.open.id, type: body.open.type === 'movie' ? 'movie' : 'series' } : null,
    target: { ids: target.ids, title: target.title, year: target.year, posterUrl: target.posterUrl, kind: target.kind },
    seasons,
    ...(Object.keys(episodes).length ? { episodes } : {}),
  });
  forgetDrift(userUUID);
  const item = typeof body?.item === 'string' ? body.item : null;
  const sent = item ? (await dashboardDriftAction(userUUID, key, 'push', [item]).catch(() => 0)) ?? 0 : 0;
  return { match, sent };
}

export async function dashboardMatchRemove(userUUID: string, key: string, group: string): Promise<boolean> {
  const source = await matchSource(userUUID, key);
  if (!source) return false;
  const { removeMatch } = require('./trackerMatch');
  await removeMatch(userUUID, source.service, group);
  forgetDrift(userUUID);
  return true;
}

function copySide(source: SyncSource, key: string): any {
  return { service: source.service, credential: source.credential, key, keys: source.keys, scoped: source.scoped };
}

async function copyPair(userUUID: string, viewer: string | null, fromKey: string, toKey: string, what: string): Promise<{ from: SyncSource; to: SyncSource } | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  if (!config || fromKey === toKey) return null;
  const sources = syncSources(config, userUUID, historyKeyOf(config, userUUID, viewer));
  const from = sources.get(fromKey);
  const to = sources.get(toKey);
  if (!from || !to) return null;
  const source = trackerOf(from.service);
  if (what === 'watches') return source?.datedHistory ? { from, to } : null;
  return source?.marks.from.includes(what as Mark) && trackerOf(to.service)?.marks.to.includes(what as Mark) ? { from, to } : null;
}

async function named(userUUID: string, videos: string[]): Promise<Record<string, { title: string | null; imageUrl: string | null; posterUrl: string | null }>> {
  const out: Record<string, { title: string | null; imageUrl: string | null; posterUrl: string | null }> = {};
  await mapWithConcurrency([...new Set(videos)].slice(0, 120), envInt('JELLYFIN_DASHBOARD_DESCRIBE_CONCURRENCY', 8, 1), async (video: string) => {
    const n = await withDeadline(describe(userUUID, video).catch(() => null));
    out[video] = { title: n && n.title !== video ? n.title : null, imageUrl: n?.backdropUrl ?? n?.imageUrl ?? null, posterUrl: n?.posterUrl ?? null };
  });
  return out;
}

async function markCopyPreview(userUUID: string, what: string, pair: { from: SyncSource; to: SyncSource }, fromKey: string, toKey: string, since: number, retry: boolean): Promise<any> {
  const { planMarkCopy } = require('./trackerCopy');
  const { markVideo } = require('./trackerMarks');
  const plan = await planMarkCopy(userUUID, what, copySide(pair.from, fromKey), copySide(pair.to, toKey), since, false, retry);
  const count = (kind: string) => plan.items.filter((item: any) => item.kind === kind).length;
  const list = plan.items.map((item: any) => ({ id: item.metaId, kind: item.kind, count: 1, lastAt: item.at, video: markVideo(item), rating: item.rating, season: item.season, episode: item.episode }));
  return {
    from: fromKey,
    to: toKey,
    since,
    what,
    checkedAt: plan.checkedAt,
    totals: { films: count('movie'), shows: count('series'), seasons: count('season'), episodes: count('episode'), titles: list.length, excluded: plan.excluded, undated: plan.items.filter((item: any) => !item.at).length, reasons: plan.reasons },
    titles: list,
    named: await named(userUUID, list.slice(0, 60).map((t: any) => t.video)),
  };
}

export async function dashboardCopyPreview(userUUID: string, profile: string | null, fromKey: string, toKey: string, since: number, what = 'watches', retry = false): Promise<any | null> {
  const pair = await copyPair(userUUID, profile, fromKey, toKey, what);
  if (!pair) return null;
  if (what !== 'watches') return markCopyPreview(userUUID, what, pair, fromKey, toKey, since, retry);
  const { planCopy } = require('./trackerCopy');
  const { spellingFor } = require('./trackerDrift');
  const plan = await planCopy(userUUID, copySide(pair.from, fromKey), copySide(pair.to, toKey), since, false, retry);
  const titles = new Map<string, { id: string; kind: string; episodes: Set<string>; lastAt: number; video: string }>();
  let films = 0;
  let episodes = 0;
  let undated = 0;
  for (const item of plan.items) {
    if (item.kind === 'movie') films += 1;
    else episodes += 1;
    if (!item.at) undated += 1;
    const held = titles.get(item.metaId) ?? { id: item.metaId, kind: item.kind, episodes: new Set<string>(), lastAt: 0, video: spellingFor(pair.to.service, item.ids) };
    held.episodes.add(`${item.season}:${item.episode}`);
    if ((item.at ?? 0) > held.lastAt) {
      held.lastAt = item.at ?? 0;
      held.video = spellingFor(pair.to.service, item.ids);
    }
    titles.set(item.metaId, held);
  }
  const list = [...titles.values()].sort((a, b) => b.lastAt - a.lastAt).map((t) => ({ id: t.id, kind: t.kind, count: t.kind === 'movie' ? 1 : t.episodes.size, lastAt: t.lastAt || null, video: t.video }));
  return {
    from: fromKey,
    to: toKey,
    since,
    what,
    checkedAt: plan.checkedAt,
    totals: { films, episodes, titles: list.length, excluded: plan.excluded, undated, blocked: plan.blocked },
    titles: list,
    named: await named(userUUID, list.slice(0, 60).map((t) => t.video)),
  };
}

export async function dashboardCopyDescribe(userUUID: string, videos: string[]): Promise<any> {
  return named(userUUID, videos);
}

export async function dashboardCopyStart(userUUID: string, profile: string | null, fromKey: string, toKey: string, since: number, titles: string[] | null, what = 'watches', retry = false): Promise<number | null> {
  const pair = await copyPair(userUUID, profile, fromKey, toKey, what);
  if (!pair) return null;
  const { startCopy } = require('./trackerCopy');
  return startCopy(userUUID, [...pair.to.keys][0] ?? '', copySide(pair.from, fromKey), copySide(pair.to, toKey), since, titles, what, retry);
}

export async function dashboardCopyJobs(userUUID: string): Promise<any[]> {
  const rows: any[] = await database.listCopyJobs(userUUID, 10).catch(() => []);
  return rows.map((row) => ({
    id: Number(row.id),
    from: String(row.from_key),
    to: String(row.to_key),
    fromService: String(row.from_service),
    toService: String(row.to_service),
    what: String(row.what ?? 'watches'),
    status: String(row.status),
    total: Number(row.total) || 0,
    done: Number(row.cursor) || 0,
    sent: Number(row.sent) || 0,
    failed: Number(row.failed) || 0,
    skipped: Number(row.skipped) || 0,
    nextAt: Number(row.next_at) || null,
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: Number(row.created_at),
    finishedAt: row.finished_at ? Number(row.finished_at) : null,
  }));
}

export async function dashboardCopyControl(userUUID: string, id: number, action: 'pause' | 'resume' | 'stop'): Promise<boolean> {
  return require('./trackerCopy').controlCopy(userUUID, id, action);
}

/** One configuration: its profiles with counts, and the sessions, positions and recent plays of one profile or all. */
export async function dashboardConfiguration(userUUID: string, profile: string | null, rows?: number, offsetMinutes = 0): Promise<any> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  if (!config) return null;
  const names = profileNames(config, userUUID);
  const limit = Math.min(100, Math.max(1, rows || envInt('JELLYFIN_DASHBOARD_ROWS', 30, 1)));
  const byProfile: any[] = await database.playstateForConfiguration(userUUID);
  const [counts, sync]: [Map<string, ProfileStats>, SyncRow[]] = await Promise.all([
    profileStats(userUUID, offsetMinutes, byProfile),
    trackerSync(config, userUUID),
  ]);
  const everyProfile = listProfiles(config, userUUID);
  const history = historyKeyOf(config, userUUID, profile);
  const avatars = new Map(everyProfile.map((p) => [p.id ?? '', p.avatar]));
  const profiles = historyProfiles(config, userUUID).map(({ key, name, sharedWith }) => {
    const p = byProfile.find((row: any) => String(row.profile ?? '') === key);
    const titles = counts.get(key);
    return {
      key,
      name,
      avatar: avatars.get(key) ?? null,
      sharedWith,
      inProgress: titles?.inProgress ?? 0,
      played: titles?.played ?? 0,
      movies: titles?.movies ?? 0,
      episodes: titles?.episodes ?? 0,
      days: titles?.days ?? {},
      lastActivity: Math.max(Number(p?.last_played_at) || 0, Number(p?.updated_at) || 0) || null,
    };
  });
  const [inProgress, recentlyPlayed] = await Promise.all([
    foldedPlays(userUUID, names, 'progress', history, envInt('JELLYFIN_DASHBOARD_PROGRESS_MAX', 1000, 1)),
    foldedPlays(userUUID, names, 'played', history, limit),
  ]);
  const shown = profiles.filter((p) => history === null || p.key === history);
  const sessions = (await sessionRows(userUUID, names)).filter((s) => history === null || s.profileKey === history);
  return {
    userUUID,
    label: defaultUserName(config, userUUID),
    profile,
    history,
    rows: limit,
    profiles,
    viewers: everyProfile.map((p) => ({ key: p.id ?? '', name: p.name, avatar: p.avatar, historyKey: p.id && !p.sharesHistory ? p.id : '' })),
    sync,
    sessions,
    inProgress: inProgress.rows.slice(0, limit),
    recentlyPlayed: recentlyPlayed.rows,
    totals: {
      progress: inProgress.exhausted ? inProgress.rows.length : Math.max(inProgress.rows.length, shown.reduce((n, p) => n + p.inProgress, 0)),
      played: Math.max(recentlyPlayed.rows.length, shown.reduce((n, p) => n + p.played, 0)),
    },
  };
}

export type PlayKind = 'progress' | 'played';

async function foldedPlays(userUUID: string, names: Map<string, string>, kind: PlayKind, profile: string | null, want: number): Promise<{ rows: PlayRow[]; exhausted: boolean }> {
  const read = (n: number) => kind === 'progress'
    ? database.listPlaystateInProgressFor(userUUID, n, profile)
    : database.listViewingHistory(userUUID, n, profile);
  let ask = want * 2;
  for (;;) {
    const raw: any[] = await read(ask);
    const out = await playRows(userUUID, raw, names);
    const exhausted = raw.length < ask;
    if (out.length >= want || exhausted || ask >= want * 16) return { rows: out.slice(0, want), exhausted: exhausted && out.length <= want };
    ask *= 2;
  }
}

export async function dashboardPlays(userUUID: string, profile: string | null, kind: PlayKind, offset: number, limit: number): Promise<any | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  if (!config) return null;
  const from = Math.max(0, offset);
  const size = Math.min(100, Math.max(1, limit));
  const { rows, exhausted } = await foldedPlays(userUUID, profileNames(config, userUUID), kind, historyKeyOf(config, userUUID, profile), from + size);
  const page = rows.slice(from);
  return { kind, profile, offset: from, rows: page, done: exhausted || page.length < size };
}

/** Every row the table holds for a configuration, as stored. */
const TITLE_KEY = /^(tt\d+|[a-z]+:[^:#]+)$/;

const keyKind = (key: string) => (key.startsWith('tt') ? 'imdb' : key.split(':')[0]);

const preferredKey = (keys: string[]) => keys.find((key) => key.startsWith('tt')) ?? keys[0];

function ratingTitles(rows: any[]): Array<{ key: string; keys: string[]; rating: number; at: number; type: 'movie' | 'series' | null }> {
  const bursts: Array<{ keys: string[]; rating: number; at: number; type: 'movie' | 'series' | null }> = [];
  const sorted = rows.filter((row) => TITLE_KEY.test(String(row.meta_id))).sort((a, b) => Number(a.updated_at) - Number(b.updated_at));
  for (const row of sorted) {
    const key = String(row.meta_id);
    const at = Number(row.updated_at) || 0;
    const type = row.meta_type === 'movie' || row.meta_type === 'series' ? row.meta_type : null;
    const last = bursts[bursts.length - 1];
    if (last && last.rating === Number(row.rating) && at - last.at <= 1000 && !last.keys.some((held) => keyKind(held) === keyKind(key))) {
      last.keys.push(key);
      last.at = at;
      last.type = last.type ?? type;
      continue;
    }
    bursts.push({ keys: [key], rating: Number(row.rating), at, type });
  }
  return bursts.map((b) => ({ key: preferredKey(b.keys), keys: b.keys, rating: b.rating, at: b.at, type: b.type })).sort((a, b) => b.at - a.at);
}

const droppedMemo = new LRUCache<string, string[]>({ max: 200, ttl: envInt('JELLYFIN_DASHBOARD_STATS_TTL', 120, 10) * 1000 });

async function droppedShows(userUUID: string, profile: string, ids: string[], config: any): Promise<string[]> {
  const keys = ids.filter((id) => TITLE_KEY.test(id)).sort();
  const memo = `${userUUID}:${profile}:${keys.join(',')}`;
  const held = droppedMemo.get(memo);
  if (held) return held;
  const { watchlistIdentity } = require('./canonicalIds');
  const identities: string[] = await mapWithConcurrency(keys, 8, (id: string) =>
    watchlistIdentity(id, 'series', config).then((identity: { key: string }) => identity.key).catch(() => id)
  );
  const groups = new Map<string, string[]>();
  keys.forEach((id, i) => groups.set(identities[i], [...(groups.get(identities[i]) ?? []), id]));
  const shows = [...groups.values()].map(preferredKey);
  droppedMemo.set(memo, shows);
  return shows;
}

// An id no profile has any more scopes to the main one, so it is refused rather than acted on as that profile.
const scopedTo = (config: any, profile: string | null): boolean => !profile || config?.jellyfinProfileId === profile;

export function asProfile<T>(userUUID: string, profile: string | null, work: (config: any) => Promise<T>): Promise<T | null> {
  const { runInViewerScope } = require('./viewer');
  const { loadConfig } = require('./context');
  return runInViewerScope(false, async () => {
    const config = await loadConfig({ jellyfin: { userUUID, profileId: profile || null } }).catch(() => null);
    return config && scopedTo(config, profile) ? work(config) : null;
  });
}

export interface DeviceRow {
  deviceId: string;
  client: string;
  device: string;
  version: string;
  lastSeen: number;
  canOpen: boolean;
  canPlay: boolean;
}

export function dashboardDevices(userUUID: string, profile: string | null): Promise<DeviceRow[] | null> {
  return asProfile(userUUID, profile, async (config) => {
    const { liveDevices } = require('./socket');
    const devices: Array<{ deviceId: string; client: string; device: string; version: string; lastSeen: number; playableMediaTypes?: string[]; supportedCommands: string[]; supportsMediaControl?: boolean }> =
      await liveDevices(userUUID, profileKey(config));
    return devices.map((device) => ({
      deviceId: device.deviceId,
      client: device.client,
      device: device.device,
      version: device.version,
      lastSeen: device.lastSeen,
      canOpen: device.supportedCommands.includes('DisplayContent'),
      // A client that turns remote control off ignores Play, as the server's own session list already says.
      canPlay: device.supportsMediaControl !== false && (device.playableMediaTypes ?? []).includes('Video'),
    }));
  });
}

export interface OpenOnTarget {
  itemId: string;
  itemType: string;
  itemName: string;
  play: boolean;
  startPositionTicks?: number;
}

export function dashboardOpenOn(userUUID: string, profile: string | null, deviceId: string, target: OpenOnTarget): Promise<boolean | null> {
  return asProfile(userUUID, profile, async (config) => {
    const { sendToDevice } = require('./socket');
    const { profileUserId } = require('./profiles');
    const ControllingUserId = profileUserId(userUUID, profile || null);
    const message = target.play
      ? ['Play', { ItemIds: [target.itemId], PlayCommand: 'PlayNow', ControllingUserId, ...(target.startPositionTicks ? { StartPositionTicks: target.startPositionTicks } : {}) }]
      : ['GeneralCommand', { Name: 'DisplayContent', ControllingUserId, Arguments: { ItemId: target.itemId, ItemName: target.itemName, ItemType: target.itemType } }];
    return sendToDevice(userUUID, profileKey(config), deviceId, message[0], message[1]);
  });
}

export interface ShowRow {
  metaId: string;
  title: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  source: string;
  lastWatchedAt: number | null;
  outcome: string;
  next: { season: number | null; number: number | null; name: string | null } | null;
  from: { season: number | null; number: number | null; name: string | null } | null;
  last: { season: number | null; number: number | null } | null;
  airsAt: number | null;
  episodes: number | null;
  watched: number | null;
  total: number | null;
}

const showsMemo = new LRUCache<string, Promise<{ rows: ShowRow[]; ms: number } | null>>({
  max: 100,
  ttl: envInt('JELLYFIN_DASHBOARD_STATS_TTL', 120, 10) * 1000,
});

export function dashboardShows(userUUID: string, profile: string | null, fresh = false): Promise<{ rows: ShowRow[]; ms: number } | null> {
  const key = `${userUUID}:${profile ?? ''}`;
  const held = fresh ? undefined : showsMemo.get(key);
  if (held) return held;
  const work = readShows(userUUID, profile);
  showsMemo.set(key, work);
  work.catch(() => showsMemo.delete(key));
  return work;
}

async function readShows(userUUID: string, profile: string | null): Promise<{ rows: ShowRow[]; ms: number } | null> {
  return asProfile(userUUID, profile, async (config) => {
    const started = Date.now();
    const events = new Map<string, { row: any; source: string; step: any }>();
    const { explainNextUp } = require('./index');
    const ran = await explainNextUp(userUUID, config, (row: any, source: string, step: any) => {
      if (!row?.metaId) return;
      const held = events.get(row.metaId);
      if (held && step.outcome === 'shown' && held.step.outcome !== 'shown') return;
      events.set(row.metaId, { row, source, step });
    });
    if (!ran) return null;
    const ms = Date.now() - started;
    const listed = [...events.values()].filter((e) => e.step.outcome !== 'duplicate');
    const rows = await mapWithConcurrency(listed, envInt('JELLYFIN_DASHBOARD_DESCRIBE_CONCURRENCY', 8, 1), async ({ row, source, step }): Promise<ShowRow> => {
      const meta = step.meta ?? (await seriesIndex(userUUID, row.metaId, { held: true }).catch(() => null))
        ?? (await withDeadline(seriesIndex(userUUID, row.metaId).catch(() => null)));
      const ended = step.outcome === 'caught-up'
        && seriesStatus((await withDeadline(fetchMeta(userUUID, 'series', String(meta?.id ?? row.metaId)).catch(() => null))) ?? {}) === 'Ended';
      return {
        metaId: String(meta?.id ?? row.metaId),
        title: meta?.name ?? row.metaId,
        posterUrl: meta?.poster ?? null,
        backdropUrl: meta?.background ?? null,
        source,
        lastWatchedAt: Number(row.lastWatchedAt) || null,
        outcome: !ended ? step.outcome : step.total && (step.watched ?? 0) < step.total ? 'unfinished' : 'finished',
        next: step.next ?? null,
        from: step.from ?? null,
        last: row.episode !== undefined && row.episode !== null ? { season: row.season ?? null, number: row.episode } : null,
        airsAt: step.airsAt ?? null,
        episodes: step.episodes ?? null,
        watched: step.watched ?? null,
        total: step.total ?? null,
      };
    });
    const seen = new Set<string>();
    return {
      ms,
      rows: rows
        .filter((row) => (seen.has(row.metaId) ? false : (seen.add(row.metaId), true)))
        .sort((a, b) => (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0)),
    };
  });
}

export async function refreshShow(userUUID: string, metaId: string): Promise<boolean> {
  const { refreshSeriesIndex } = require('./episodeIndex');
  const { invalidateResume } = require('./resume');
  const fresh = await refreshSeriesIndex(userUUID, metaId);
  invalidateResume(userUUID);
  for (const key of [...showsMemo.keys()]) if (key.startsWith(`${userUUID}:`)) showsMemo.delete(key);
  return Boolean(fresh);
}

export interface CalendarRow {
  id: string;
  seriesId: string | null;
  seriesName: string;
  name: string | null;
  season: number | null;
  number: number | null;
  premiereDate: string | null;
  played: boolean;
  still: string | null;
  thumb: string | null;
  backdrop: string | null;
  logo: string | null;
}

const CALENDAR_SPAN_DAYS = 45;

export async function dashboardCalendar(userUUID: string, profile: string | null, from: number, to: number): Promise<CalendarRow[] | null> {
  return asProfile(userUUID, profile, async (config) => {
    const dayMs = 24 * 60 * 60 * 1000;
    const end = Math.min(to, from + CALENDAR_SPAN_DAYS * dayMs);
    const { readCalendar } = require('./index');
    const items: any[] | null = await readCalendar(userUUID, config, from, end);
    if (!items) return null;
    const image = (id: unknown, type: string, tag: unknown): string | null =>
      id && tag ? `/jellyfin/${encodeURIComponent(userUUID)}/Items/${encodeURIComponent(String(id))}/Images/${type}?tag=${encodeURIComponent(String(tag))}` : null;
    return items
      .filter((item) => item?.Type === 'Episode')
      .map((item) => ({
        id: String(item.Id),
        seriesId: item.SeriesId ? String(item.SeriesId) : null,
        seriesName: String(item.SeriesName ?? item.Name ?? ''),
        name: item.Name ?? null,
        season: Number.isFinite(item.ParentIndexNumber) ? item.ParentIndexNumber : null,
        number: Number.isFinite(item.IndexNumber) ? item.IndexNumber : null,
        premiereDate: item.PremiereDate ?? null,
        played: item.UserData?.Played === true,
        still: image(item.Id, 'Primary', item.ImageTags?.Primary),
        thumb: image(item.ParentThumbItemId, 'Thumb', item.ParentThumbImageTag),
        backdrop: image(item.ParentBackdropItemId, 'Backdrop', item.ParentBackdropImageTags?.[0]),
        logo: image(item.ParentLogoItemId, 'Logo', item.ParentLogoImageTag),
      }));
  });
}

export interface LibraryRow {
  metaId: string;
  type: 'movie' | 'series';
  title: string;
  year: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  logoUrl: string | null;
  overview: string | null;
  score: string | null;
  genres: string[];
  at: number | null;
  rating: number | null;
}

export type LibraryTab = 'watchlist' | 'ratings' | 'dropped';

const libraryNames = new LRUCache<string, Omit<LibraryRow, 'at' | 'rating'> | null>({
  max: 5000,
  ttl: envInt('JELLYFIN_DASHBOARD_TITLE_TTL', 24 * 60 * 60, 60) * 1000,
});

const TIMED_OUT = Symbol('timed out');

const aliasMatches = (meta: any, aliases: string[]): number => aliases.filter((alias) => {
  const [kind, value] = alias.split(':');
  return (kind === 'tvdb' && String(meta?._tvdbId ?? '') === value) || (kind === 'tmdb' && String(meta?._tmdbId ?? '') === value);
}).length;

async function describeTitle(userUUID: string, metaId: string, types: Array<'movie' | 'series'>, aliases?: string[]): Promise<Omit<LibraryRow, 'at' | 'rating'> | null> {
  const checked = Boolean(aliases && aliases.length > 1 && types.length > 1);
  const key = `${userUUID}:${types.join(',')}:${metaId}${checked ? `:${aliases!.join(',')}` : ''}`;
  if (libraryNames.has(key)) return libraryNames.get(key) ?? null;
  let timedOut = false;
  const fetched = checked
    ? await Promise.all(types.map((type) => withDeadline(fetchMeta(userUUID, type, metaId).catch(() => null), TIMED_OUT)))
    : null;
  if (fetched) {
    const scores = fetched.map((meta) => (meta && meta !== TIMED_OUT ? aliasMatches(meta, aliases!) : -1));
    const best = scores.indexOf(Math.max(...scores));
    if (best > 0) {
      types = [types[best], ...types.filter((_, i) => i !== best)];
      fetched.unshift(...fetched.splice(best, 1));
    }
  }
  for (const [i, type] of types.entries()) {
    const meta = fetched ? fetched[i] : await withDeadline(fetchMeta(userUUID, type, metaId).catch(() => null), TIMED_OUT);
    if (meta === TIMED_OUT) {
      timedOut = true;
      continue;
    }
    if (!meta) continue;
    const named = {
      metaId: String(meta.id ?? metaId),
      type,
      title: String(meta.name ?? metaId),
      year: meta.releaseInfo ? String(meta.releaseInfo) : meta.year ? String(meta.year) : null,
      posterUrl: meta.poster ?? null,
      backdropUrl: meta.background ?? null,
      logoUrl: meta.logo ?? null,
      overview: meta.description ? String(meta.description).slice(0, 400) : null,
      score: Number.isFinite(Number.parseFloat(meta.imdbRating)) ? String(meta.imdbRating) : null,
      genres: Array.isArray(meta.genres) ? meta.genres.slice(0, 3).map(String) : [],
    };
    libraryNames.set(key, named);
    return named;
  }
  if (!timedOut) libraryNames.set(key, null, { ttl: envInt('JELLYFIN_DASHBOARD_MISS_TTL', 600, 10) * 1000 });
  return null;
}

export type LibraryKind = 'all' | 'movie' | 'series';

export interface LibraryPick {
  metaId: string;
  types: Array<'movie' | 'series'>;
  at: number | null;
  rating: number | null;
}

/** A profile's rated titles or dropped shows, newest first. */
export async function libraryPicks(userUUID: string, config: any, tab: 'ratings' | 'dropped'): Promise<LibraryPick[]> {
  const key = profileKey(config);
  if (tab === 'ratings') {
    const ratings = await database.listProfileRatings(userUUID, key, 5000).catch(() => [] as any[]);
    const rated = ratingTitles(ratings).slice(0, envInt('JELLYFIN_DASHBOARD_RATINGS_MAX', 500, 1));
    return mapWithConcurrency(rated, envInt('JELLYFIN_DASHBOARD_DESCRIBE_CONCURRENCY', 8, 1), async (r): Promise<LibraryPick> => {
      const guess: Array<'movie' | 'series'> = r.type ? [r.type] : r.key.startsWith('tt') ? ['movie', 'series'] : ['series', 'movie'];
      const named = r.type ? null : await describeTitle(userUUID, r.key, guess, r.keys);
      // Kept, so a rating saved before kinds were stored is looked up once rather than on every read.
      if (named) void database.setRatingType(userUUID, key, r.keys, named.type).catch(() => undefined);
      return { metaId: r.key, types: named ? [named.type] : guess, at: r.at, rating: r.rating };
    });
  }
  const { watchedSnapshot } = require('./watched');
  const snapshot = await watchedSnapshot(userUUID, config).catch(() => null);
  const [dropped, local] = await Promise.all([
    droppedShows(userUUID, key, [...(snapshot?.dropped ?? [])].map(String), config),
    database.listDropped(userUUID, key).catch(() => [] as any[]),
  ]);
  // Only a drop made here has a time; a tracker reports the show and not when.
  const droppedAt = new Map<string, number>(local.map((row: any) => [String(row.meta_id), Number(row.updated_at) || 0]));
  return dropped
    .map((metaId): LibraryPick => ({ metaId, types: ['series'], at: droppedAt.get(metaId) || null, rating: null }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** Where the profile's watchlist is read from. */
export function watchlistOrigins(config: any): string[] {
  const { watchlistPicks, keepsServerWatchlist } = require('./watchlistSources');
  return [...watchlistPicks(config).keys()].map(String).concat(keepsServerWatchlist(config) ? ['server'] : []);
}

export async function dashboardLibrary(userUUID: string, profile: string | null, tab: LibraryTab, kind: LibraryKind, offset: number, limit: number): Promise<any | null> {
  return asProfile(userUUID, profile, async (config) => {
    const key = profileKey(config);
    const cap = Math.min(200, Math.max(1, limit));
    const from = Math.max(0, offset);
    const { watchlistEntries } = require('./watchlist');
    const { watchedSnapshot } = require('./watched');
    const [watchlist, ratings, snapshot] = await Promise.all([
      watchlistEntries(userUUID, config).catch(() => ({ entries: [] as any[], complete: false })),
      database.listProfileRatings(userUUID, key, 5000).catch(() => [] as any[]),
      watchedSnapshot(userUUID, config).catch(() => null),
    ]);
    const rated = ratingTitles(ratings);
    const dropped = await droppedShows(userUUID, key, [...(snapshot?.dropped ?? [])].map(String), config);

    type Pick = { metaId: string; types: Array<'movie' | 'series'>; at: number | null; rating: number | null; aliases?: string[] };
    const describeAll = async (picked: Pick[]): Promise<LibraryRow[]> => {
      const described = await mapWithConcurrency(picked, envInt('JELLYFIN_DASHBOARD_DESCRIBE_CONCURRENCY', 8, 1), async (entry): Promise<LibraryRow> => {
        const named = await describeTitle(userUUID, entry.metaId, entry.types, entry.aliases);
        return named
          ? { ...named, at: entry.at, rating: entry.rating }
          : { metaId: entry.metaId, type: entry.types[0], title: entry.metaId, year: null, posterUrl: null, backdropUrl: null, logoUrl: null, overview: null, score: null, genres: [], at: entry.at, rating: entry.rating };
      });
      const seen = new Set<string>();
      return described.filter((row) => (seen.has(row.metaId) ? false : (seen.add(row.metaId), true)));
    };
    const isFilm = (e: any) => e.mediaType === 'movie' || Boolean(e.film);
    const fits = (type: 'movie' | 'series') => kind === 'all' || kind === type;
    let total: number;
    let kinds: { movie: number; series: number };
    let rows: LibraryRow[];
    if (tab === 'watchlist') {
      const films = watchlist.entries.filter(isFilm).length;
      kinds = { movie: films, series: watchlist.entries.length - films };
      const listed = watchlist.entries.filter((e: any) => fits(isFilm(e) ? 'movie' : 'series'));
      total = listed.length;
      rows = await describeAll(listed.slice(from, from + cap).map((e: any) => ({ metaId: e.metaId, types: isFilm(e) ? ['movie'] : ['series'], at: e.addedAt || null, rating: null })));
    } else if (tab === 'dropped') {
      kinds = { movie: 0, series: dropped.length };
      const listed = kind === 'movie' ? [] : dropped;
      total = listed.length;
      rows = await describeAll(listed.slice(from, from + cap).map((metaId) => ({ metaId, types: ['series'], at: null, rating: null })));
    } else {
      const all = await describeAll(rated.slice(0, envInt('JELLYFIN_DASHBOARD_RATINGS_MAX', 500, 1)).map((r) => ({ metaId: r.key, types: r.type ? [r.type] : r.key.startsWith('tt') ? ['movie', 'series'] : ['series', 'movie'], at: r.at, rating: r.rating, aliases: r.type ? undefined : r.keys })));
      kinds = { movie: all.filter((r) => r.type === 'movie').length, series: all.filter((r) => r.type === 'series').length };
      const listed = all.filter((r) => fits(r.type));
      total = listed.length;
      rows = listed.slice(from, from + cap);
    }
    return {
      tab,
      kind,
      offset: from,
      total,
      kinds,
      counts: { watchlist: watchlist.entries.length, ratings: rated.length, dropped: dropped.length },
      sources: watchlistOrigins(config),
      complete: watchlist.complete !== false,
      rows,
    };
  });
}

export async function undropShow(userUUID: string, profile: string | null, metaId: string): Promise<boolean | null> {
  return asProfile(userUUID, profile, async (config) => {
    const { rateSeries, clearLocalDrop } = require('./dropped');
    const undropped = await rateSeries(userUUID, config, { k: 'series', i: metaId }, null);
    const cleared = await clearLocalDrop(userUUID, config, metaId).catch(() => false);
    for (const key of [...showsMemo.keys()]) if (key.startsWith(`${userUUID}:`)) showsMemo.delete(key);
    return Boolean(undropped || cleared);
  });
}

const ANIME_IDS = /^(kitsu|mal|anilist|anidb):/;
const TICKS_PER_MS = 10_000;

function titleItemId(ref: { item?: string; id?: string; type?: string }): string | null {
  if (ref.item) return ref.item;
  if (!ref.id) return null;
  const { encodeJellyfinId } = require('./ids');
  const movie = ref.type === 'movie';
  return encodeJellyfinId({ k: movie ? 'movie' : 'series', t: movie ? 'movie' : ANIME_IDS.test(ref.id) ? 'anime' : 'series', i: ref.id });
}

function sameItem(a: string | null, b: string): boolean {
  const { normaliseJellyfinId } = require('./ids');
  return Boolean(a) && normaliseJellyfinId(a) === normaliseJellyfinId(b);
}

function playOf(data: any) {
  return {
    played: data?.Played === true,
    playCount: Number(data?.PlayCount) || 0,
    lastPlayedAt: data?.LastPlayedDate ? Date.parse(data.LastPlayedDate) || null : null,
    positionMs: Math.round((Number(data?.PlaybackPositionTicks) || 0) / TICKS_PER_MS),
  };
}

type TitleIds = Record<'imdb' | 'tmdb' | 'tvdb' | 'mal' | 'kitsu' | 'anilist' | 'anidb', string | null>;

async function titleIds(meta: any, film: boolean): Promise<TitleIds> {
  const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));
  const ids: TitleIds = {
    imdb: text(meta.imdb_id ?? meta._imdbId),
    tmdb: text(meta._tmdbId),
    tvdb: text(meta._tvdbId),
    mal: text(meta._malId),
    kitsu: text(meta._kitsuId),
    anilist: text(meta._anilistId),
    anidb: text(meta._anidbId),
  };
  const fill = (id: string) => {
    if (/^tt\d+$/.test(id)) ids.imdb ??= id;
    const [kind, value] = id.split(':');
    if (value && kind in ids && kind !== 'imdb') ids[kind as keyof TitleIds] ??= value;
  };
  if (meta.id) fill(String(meta.id));
  if (film) {
    const { videoIdAliases } = require('./aliases');
    for (const id of [meta.id, ids.imdb, ids.tmdb && `tmdb:${ids.tmdb}`]) {
      if (id) for (const alias of await videoIdAliases(String(id)).catch(() => [] as string[])) fill(alias);
    }
  } else if (!ids.mal && !ids.kitsu && !ids.anilist && !ids.anidb) {
    const idMapper: any = require('../id-mapper');
    const seasonOf = (entry: any) => Number(entry.season?.tvdb ?? entry.season?.tmdb ?? 1);
    const first = [...(ids.tvdb ? idMapper.getSiblingsByTvdbId(ids.tvdb) : []), ...(ids.tmdb ? idMapper.getSeriesMappingsByTmdbId(ids.tmdb) : [])]
      .filter((entry: any) => entry?.type && idMapper.mappingIsType(entry, 'series') && seasonOf(entry) > 0)
      .sort((x: any, y: any) => seasonOf(x) - seasonOf(y) || (Number(x.mal_id) || Infinity) - (Number(y.mal_id) || Infinity))[0];
    if (first) {
      ids.mal = text(first.mal_id);
      ids.kitsu = text(first.kitsu_id);
      ids.anilist = text(first.anilist_id);
      ids.anidb = text(first.anidb_id);
    }
  }
  return ids;
}

function viewings(ats: number[], runtimeMs: number): number[] {
  const within = sameViewingMs(runtimeMs);
  const out: number[] = [];
  for (const at of [...new Set(ats)].sort((x, y) => x - y)) {
    if (!out.length || at - out[out.length - 1] >= within) out.push(at);
  }
  return out.reverse();
}

async function titleWatches(userUUID: string, config: any, meta: any, item: any, episodes: any[]): Promise<Map<string, number[]>> {
  const { videoIdAliases } = require('./aliases');
  const videoOf = async (id: unknown): Promise<string | null> => {
    const descriptor = await decodeJellyfinId(String(id)).catch(() => null);
    return descriptor ? stremioIdFor(descriptor) : null;
  };
  const spellings = new Map<string, string[]>();
  const runtimes = new Map<string, number>([[String(item.Id), (Number(item.RunTimeTicks) || 0) / 10_000]]);
  for (const ep of episodes) runtimes.set(String(ep.Id), (Number(ep.RunTimeTicks) || 0) / 10_000);
  if (item.Type === 'Movie') {
    const own = await videoOf(item.Id);
    spellings.set(String(item.Id), [own, meta.id, meta._imdbId, meta.imdb_id, meta._tmdbId && `tmdb:${meta._tmdbId}`].filter(Boolean).map(String));
  }
  await mapWithConcurrency(episodes, 8, async (ep: any) => {
    const own = await videoOf(ep.Id);
    if (own) spellings.set(String(ep.Id), [own, ...(await videoIdAliases(own).catch(() => [] as string[]))]);
  });
  const rows = await database.listWatchesFor(userUUID, profileKey(config), [...spellings.values()].flat());
  const byVideo = new Map<string, number[]>();
  for (const row of rows) byVideo.set(row.video_id, [...(byVideo.get(row.video_id) ?? []), row.watched_at]);
  const out = new Map<string, number[]>();
  for (const [id, ids] of spellings) {
    const ats = viewings(ids.flatMap((videoId) => byVideo.get(videoId) ?? []), runtimes.get(id) ?? 0);
    if (ats.length) out.set(id, ats);
  }
  return out;
}

export async function dashboardTitle(userUUID: string, profile: string | null, ref: { item?: string; id?: string; type?: string }): Promise<any | null> {
  return asProfile(userUUID, profile, async (config) => {
    const itemId = titleItemId(ref);
    if (!itemId) return null;
    const { readTitle } = require('./index');
    const read = await readTitle(userUUID, config, itemId);
    if (!read) return null;
    const { meta, item, episodes, seasons: builtSeasons } = read;
    const watches = await titleWatches(userUUID, config, meta, item, episodes).catch(() => new Map<string, number[]>());
    const image = (id: unknown, type: string, tag: unknown): string | null =>
      id && tag ? `/jellyfin/${encodeURIComponent(userUUID)}/Items/${encodeURIComponent(String(id))}/Images/${type}?tag=${encodeURIComponent(String(tag))}` : null;
    const now = Date.now();
    const list = episodes.map((ep: any) => ({
      id: String(ep.Id),
      season: Number.isFinite(ep.ParentIndexNumber) ? ep.ParentIndexNumber : null,
      number: Number.isFinite(ep.IndexNumber) ? ep.IndexNumber : null,
      name: ep.Name ?? null,
      overview: ep.Overview ?? null,
      airsAt: ep.PremiereDate ? Date.parse(ep.PremiereDate) || null : null,
      runtimeMs: Math.round((Number(ep.RunTimeTicks) || 0) / TICKS_PER_MS),
      still: image(ep.Id, 'Primary', ep.ImageTags?.Primary),
      ...playOf(ep.UserData),
      watches: watches.get(String(ep.Id)) ?? [],
    }));
    const aired = list.filter((ep: any) => ep.season !== 0 && !(ep.airsAt && ep.airsAt > now));
    const seasons = (builtSeasons ?? []).map((season: any) => ({
      season: Number(season.IndexNumber),
      id: String(season.Id),
      name: season.Name ?? null,
      tag: season.ImageTags?.Primary ?? null,
      poster: image(season.Id, 'Primary', season.ImageTags?.Primary),
      count: Number(season.ChildCount) || 0,
    }));
    const rated = { ...item };
    await require('./criticRatings').withCriticRatings(rated, true)?.catch(() => undefined);
    return {
      id: String(item.Id),
      metaId: String(meta.id),
      type: item.Type === 'Movie' ? 'movie' : 'series',
      linkable: sameItem(titleItemId({ id: String(meta.id), type: item.Type === 'Movie' ? 'movie' : 'series' }), String(item.Id)),
      title: meta.name ?? item.Name,
      year: meta.releaseInfo ? String(meta.releaseInfo) : meta.year ? String(meta.year) : null,
      overview: meta.description ?? null,
      genres: Array.isArray(meta.genres) ? meta.genres.map(String) : [],
      certification: item.OfficialRating ? String(item.OfficialRating) : null,
      studios: (Array.isArray(item.Studios) ? item.Studios : []).map((studio: any) => String(studio?.Name ?? '')).filter(Boolean),
      tags: (Array.isArray(item.Tags) ? item.Tags : []).map(String),
      ratings: Array.isArray(rated.aiostreams?.ratings) ? rated.aiostreams.ratings : [],
      score: Number.isFinite(Number.parseFloat(meta.imdbRating)) ? String(meta.imdbRating) : null,
      runtime: meta.runtime ? String(meta.runtime) : null,
      releasedAt: meta.released ? Date.parse(String(meta.released)) || null : null,
      status: item.Type === 'Movie' ? null : seriesStatus(meta) ?? null,
      posterUrl: meta.poster ?? null,
      backdropUrl: meta.background ?? null,
      logoUrl: meta.logo ?? null,
      ids: await titleIds(meta, item.Type === 'Movie'),
      onWatchlist: item.UserData?.IsFavorite === true,
      dropped: item.UserData?.Likes === false,
      rating: Number.isFinite(Number(item.UserData?.Rating)) && item.UserData?.Rating !== null ? Number(item.UserData.Rating) : null,
      ...playOf(item.UserData),
      watches: watches.get(String(item.Id)) ?? [],
      episodes: list,
      seasons,
      people: (Array.isArray(item.People) ? item.People : []).map((person: any) => ({
        id: String(person.Id),
        name: String(person.Name ?? ''),
        role: person.Role ? String(person.Role) : null,
        type: String(person.Type ?? ''),
        photo: image(person.Id, 'Primary', person.PrimaryImageTag),
      })),
      watched: aired.filter((ep: any) => ep.played).length,
      aired: aired.length,
    };
  });
}

const yearFrom = (value: unknown): number | null => {
  const year = Number.parseInt(String(value ?? '').slice(0, 4), 10);
  return Number.isFinite(year) && year > 1800 ? year : null;
};

export async function dashboardPerson(userUUID: string, profile: string | null, personId: string): Promise<any | null> {
  return asProfile(userUUID, profile, async (config) => {
    const { readPerson } = require('./index');
    const read = await readPerson(userUUID, config, personId);
    if (!read) return null;
    const { item, credits } = read;
    const tag = item.ImageTags?.Primary;
    return {
      id: String(item.Id),
      name: String(item.Name ?? ''),
      overview: item.Overview || null,
      born: item.PremiereDate ?? null,
      died: item.EndDate ?? null,
      birthplace: Array.isArray(item.ProductionLocations) && item.ProductionLocations.length ? item.ProductionLocations.join(', ') : null,
      knownFor: item.KnownForType ?? null,
      photo: tag ? `/jellyfin/${encodeURIComponent(userUUID)}/Items/${encodeURIComponent(String(item.Id))}/Images/Primary?tag=${encodeURIComponent(String(tag))}` : null,
      credits: credits.map((meta: any) => ({ type: meta.type === 'movie' ? 'movie' : 'series', year: yearFrom(meta.released ?? meta.releaseInfo), roles: Array.isArray(meta._personTypes) ? meta._personTypes : [] })),
    };
  });
}

export type PersonRole = 'all' | 'Actor' | 'Director' | 'Writer' | 'Producer' | 'Composer';

export async function dashboardPersonTitles(userUUID: string, profile: string | null, personId: string, kind: LibraryKind, role: PersonRole, ascending: boolean, offset: number, limit: number): Promise<any | null> {
  return asProfile(userUUID, profile, async (config) => {
    const { readPersonTitles } = require('./index');
    const roles = role === 'all' ? [] : role === 'Actor' ? ['Actor', 'GuestStar'] : [role];
    const types = kind === 'all' ? 'Movie,Series' : kind === 'movie' ? 'Movie' : 'Series';
    const from = Math.max(0, offset);
    const { items, total, next } = await readPersonTitles(userUUID, config, personId, types, roles, from, Math.min(100, Math.max(1, limit)), ascending);
    const image = (id: unknown, tag: unknown): string | null =>
      id && tag ? `/jellyfin/${encodeURIComponent(userUUID)}/Items/${encodeURIComponent(String(id))}/Images/Primary?tag=${encodeURIComponent(String(tag))}` : null;
    return {
      offset: from,
      total,
      next,
      rows: items.map((item: any) => ({
        id: String(item.Id),
        type: item.Type === 'Movie' ? 'movie' : 'series',
        title: String(item.Name ?? ''),
        year: Number(item.ProductionYear) || yearFrom(item.PremiereDate),
        posterUrl: image(item.Id, item.ImageTags?.Primary),
        played: item.UserData?.Played === true,
        progress: Number(item.UserData?.PlayedPercentage) || 0,
      })),
    };
  });
}

export type TitleAction = 'played' | 'unplayed' | 'playedUpTo' | 'watchlist' | 'unwatchlist' | 'drop' | 'undrop' | 'rate';

export async function dashboardTitleAction(userUUID: string, profile: string | null, action: TitleAction, itemIds: string[], rating: number | null = null): Promise<boolean | null> {
  const { runInViewerScope } = require('./viewer');
  return runInViewerScope(false, async () => {
    const req = { params: { userUUID }, jellyfin: { userUUID, profileId: profile || null }, query: {}, headers: {} };
    const { loadConfig } = require('./context');
    const config = await loadConfig(req).catch(() => null);
    if (!config || !scopedTo(config, profile)) return null;
    const { decodeJellyfinId } = require('./ids');
    const playstate = require('./playstate');
    // A watchlist or rating change that could not read its title says so; a drop that had nothing to change is no failure.
    let changed = true;
    for (const itemId of itemIds) {
      if (action === 'played') await playstate.recordPlayed(req, { ItemId: itemId });
      else if (action === 'unplayed') await playstate.recordUnplayed(req, { ItemId: itemId });
      else if (action === 'playedUpTo') await playstate.recordPlayedUpTo(req, itemId);
      else {
        const descriptor = await decodeJellyfinId(itemId);
        if (!descriptor) continue;
        if (action === 'watchlist' || action === 'unwatchlist') {
          const { setWatchlisted } = require('./watchlist');
          if (!(await setWatchlisted(userUUID, config, descriptor, action === 'watchlist'))) changed = false;
        } else if (action === 'drop' || action === 'undrop') {
          const { rateSeries, clearLocalDrop } = require('./dropped');
          await rateSeries(userUUID, config, descriptor, action === 'drop' ? false : null);
          if (action === 'undrop') await clearLocalDrop(userUUID, config, descriptor.i).catch(() => false);
        } else if (action === 'rate') {
          const { rateItem, ratingFrom } = require('./ratings');
          if (!(await rateItem(userUUID, config, descriptor, ratingFrom(rating)))) changed = false;
        }
      }
    }
    forgetMemos(userUUID);
    return changed;
  });
}

export async function dashboardClearResume(userUUID: string, profileKey: string, videoId: string): Promise<boolean | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  if (!config) return null;
  const { parseStremioId } = require('./idsCodec');
  if (!parseStremioId(videoId)) return false;
  if (profileKey && !listProfiles(config, userUUID).some((p) => p.id === profileKey)) return false;
  const { runInViewerScope } = require('./viewer');
  return runInViewerScope(false, async () => {
    const req = { params: { userUUID }, jellyfin: { userUUID, profileId: profileKey || null }, query: {}, headers: {} };
    const done = await require('./playstate').recordUserData(req, { ItemId: itemIdForVideo(videoId), PlaybackPositionTicks: 0 });
    forgetMemos(userUUID);
    return Boolean(done);
  });
}

function forgetMemos(userUUID: string): void {
  for (const key of [...showsMemo.keys()]) if (key.startsWith(`${userUUID}:`)) showsMemo.delete(key);
  for (const key of [...droppedMemo.keys()]) if (key.startsWith(`${userUUID}:`)) droppedMemo.delete(key);
}

export async function dashboardWatchDate(userUUID: string, profile: string | null, itemId: string, from: number | null, to: number): Promise<boolean | null> {
  const { runInViewerScope } = require('./viewer');
  return runInViewerScope(false, async () => {
    const req = { params: { userUUID }, jellyfin: { userUUID, profileId: profile || null }, query: {}, headers: {} };
    const { loadConfig } = require('./context');
    const config = await loadConfig(req).catch(() => null);
    if (!config || !scopedTo(config, profile)) return null;
    const moved = await require('./playstate').recordWatchDate(req, itemId, from, to);
    forgetMemos(userUUID);
    return moved;
  });
}

export async function dashboardSameViewing(userUUID: string, profileKey: string, video: string, at: number, theirs: number): Promise<boolean | 'invalid' | null> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  if (!config) return null;
  if (!parseStremioId(video) || !(theirs > 0) || !(at > theirs)) return 'invalid';
  if (profileKey && !listProfiles(config, userUUID).some((p) => p.id === profileKey)) return 'invalid';
  const { videoIdAliases } = require('./aliases');
  const spellings = [video, ...(await videoIdAliases(video).catch(() => [] as string[]))];
  const gap = envInt('JELLYFIN_TRACKER_REWATCH_GAP_HOURS', 48, 48) * 60 * 60 * 1000;
  const own: number[] = ((await database.listWatchesFor(userUUID, profileKey, spellings)) as any[]).map((row) => Number(row.watched_at));
  const kept = own
    .filter((when) => Math.abs(when - at) > gap && Math.abs(when - theirs) <= gap)
    .sort((a, b) => Math.abs(a - theirs) - Math.abs(b - theirs))[0];
  const { runInViewerScope } = require('./viewer');
  return runInViewerScope(false, async () => {
    const req = { params: { userUUID }, jellyfin: { userUUID, profileId: profileKey || null }, query: {}, headers: {} };
    const done = await require('./playstate').recordWatchDate(req, itemIdForVideo(video), at, kept ?? theirs, kept !== undefined);
    forgetMemos(userUUID);
    forgetDrift(userUUID);
    return Boolean(done);
  });
}

export async function dashboardSearches(userUUID: string, profile: string | null): Promise<any | null> {
  return asProfile(userUUID, profile, async (config) => {
    const { lumiereApiBase } = require('../../utils/lumiereLists');
    const { searchCatalogs } = require('./index');
    return { quick: Boolean(lumiereApiBase()), catalogs: await searchCatalogs(userUUID, config) };
  });
}

export async function dashboardFindTitles(userUUID: string, profile: string | null, query: string, catalogId: string | null = null): Promise<any | null> {
  return asProfile(userUUID, profile, async (config) => {
    if (catalogId) {
      const { searchCatalogs, runSearchCatalog } = require('./index');
      const catalog = (await searchCatalogs(userUUID, config)).find((c: any) => c.id === catalogId);
      if (!catalog) return { query, available: false, results: [] };
      const metas: any[] = await runSearchCatalog(userUUID, config, catalog, query).catch(() => []);
      const seen = new Set<string>();
      return {
        query,
        available: true,
        results: metas.filter((meta) => meta?.id && !isBoxSetMeta(meta) && !seen.has(String(meta.id)) && seen.add(String(meta.id))).slice(0, envInt('JELLYFIN_DASHBOARD_SEARCH_RESULTS', 12, 1) * 2).map((meta) => ({
          id: String(meta.id),
          type: meta.type === 'movie' || catalog.type === 'movie' || catalog.type === 'anime.movie' ? 'movie' : 'series',
          title: String(meta.name ?? meta.id),
          year: meta.releaseInfo ? String(meta.releaseInfo) : meta.year ? String(meta.year) : null,
          posterUrl: meta.poster ?? null,
        })),
      };
    }
    const { lumiereApiBase } = require('../../utils/lumiereLists');
    const { fetchLumiereSuggest } = require('../../utils/lumiereSearch');
    const { hasAgeRatingCap } = require('../../utils/ageRating');
    const { getSetting } = require('../settingsService');
    const base = lumiereApiBase();
    if (!base || hasAgeRatingCap(config)) return { query, available: Boolean(base), results: [] };
    const timeoutMs = parseInt(getSetting('LUMIERE_SUGGEST_TIMEOUT_MS'), 10) || 1500;
    const found = await fetchLumiereSuggest(base, null, query, envInt('JELLYFIN_DASHBOARD_SEARCH_RESULTS', 12, 1), !!config.includeAdult, timeoutMs).catch(() => null);
    return {
      query,
      available: true,
      results: (found ?? []).map((title: any) => ({
        id: String(title.imdbId),
        type: title.kind === 'movie' ? 'movie' : 'series',
        title: String(title.title ?? title.imdbId),
        year: title.year ? String(title.year) : null,
        posterUrl: `https://images.metahub.space/poster/medium/${title.imdbId}/img`,
      })),
    };
  });
}
