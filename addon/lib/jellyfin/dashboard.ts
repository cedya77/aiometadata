import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { parseStremioId } from './idsCodec';
import { decodeJellyfinId, stremioIdFor } from './ids';
import { liveSessions, type LiveSession } from './playstate';
import { syncStatus } from './playstateSync';
import { seenConfigurations } from './context';
import { seriesIndex } from './episodeIndex';
import { fetchMeta, seriesStatus } from './items';
import { groupBySpelling } from './aliases';
import { defaultUserName, listProfiles, profileKey, scopeConfigToProfile } from './profiles';
import { CAPABLE, credentialFor } from './trackerSource';
import { sourceKeyFor } from './trackerMirror';
import { mapWithConcurrency } from '../../utils/concurrency';
import redis from '../redisClient';

const database: any = require('../database');

export interface PlayRow {
  profile: string;
  videoId: string;
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

// The meta's own images: an episode's still and its show's poster, a film's backdrop and poster.
async function describe(userUUID: string, videoId: string): Promise<Named> {
  const key = `${userUUID}:${videoId}`;
  const held = titles.get(key);
  if (held) return held;

  const parsed = parseStremioId(videoId);
  let out: Named = { keys: [videoId], title: videoId, episode: null, imageUrl: null, posterUrl: null, backdropUrl: null, seriesId: null, season: null, number: null, episodeTitle: null };
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
      videoId,
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
      runtimeMs: Number(row.runtime_ms) || 0,
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
  const own = (await liveSessions()).filter((s) => s.userUUID === userUUID);
  return mapWithConcurrency(own, 2, async (s) => {
    const descriptor = await decodeJellyfinId(s.itemId);
    const videoId = descriptor ? stremioIdFor(descriptor) : null;
    const named: Named = videoId ? await describe(userUUID, videoId) : { keys: [s.itemId], title: s.itemId, episode: null, imageUrl: null, posterUrl: null, backdropUrl: null, seriesId: null, season: null, number: null, episodeTitle: null };
    const viewer = s.viewer && s.viewer !== s.profile ? names.get(s.viewer) ?? s.viewer.slice(0, 8) : null;
    const held = videoId ? await database.getPlaystate(userUUID, videoId, s.profile).catch(() => null) : null;
    return { profile: profileLabel(names, s.profile), profileKey: s.profile, viewer, imageUrl: named.imageUrl, backdropUrl: named.backdropUrl, title: named.title, episode: named.episode, positionMs: s.positionMs, runtimeMs: Number(held?.runtime_ms) || 0, paused: s.paused, at: s.at };
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
}

async function trackerSync(config: any, userUUID: string): Promise<SyncRow[]> {
  const sources = new Map<string, { service: string; profiles: string[]; keys: Set<string> }>();
  for (const profile of historyProfiles(config, userUUID)) {
    const scoped = scopeConfigToProfile(config, userUUID, profile.key || null);
    for (const service of CAPABLE) {
      const credential = credentialFor(scoped, service);
      if (!credential) continue;
      const key = sourceKeyFor(service, credential);
      const source = sources.get(key) ?? { service, profiles: [], keys: new Set<string>() };
      source.profiles.push(profile.name);
      source.keys.add(profile.key);
      sources.set(key, source);
    }
  }
  const queued: any[] = await database.outboxForConfiguration(userUUID).catch(() => []);
  return mapWithConcurrency([...sources.entries()], 4, async ([key, source]): Promise<SyncRow> => {
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
    };
  });
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
export async function dashboardExport(userUUID: string): Promise<any> {
  const config = await database.getUserConfig(userUUID).catch(() => null);
  const names = config ? profileNames(config, userUUID) : new Map<string, string>();
  const rows: any[] = await database.listPlaystateFor(userUUID);
  const watches: any[] = await database.listWatchesForConfiguration(userUUID).catch(() => []);
  return {
    userUUID,
    label: config ? defaultUserName(config, userUUID) : userUUID.slice(0, 8),
    exportedAt: new Date().toISOString(),
    profiles: [...names.entries()].map(([key, name]) => ({ key, name })),
    rows: rows.map((row) => ({
      profile: String(row.profile ?? ''),
      videoId: String(row.video_id),
      positionMs: Number(row.position_ms) || 0,
      runtimeMs: Number(row.runtime_ms) || 0,
      played: Boolean(row.played),
      playCount: Number(row.play_count) || 0,
      lastPlayedAt: row.last_played_at ? new Date(Number(row.last_played_at)).toISOString() : null,
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    })),
    watches: watches.map((row) => ({
      profile: String(row.profile ?? ''),
      videoId: String(row.video_id),
      watchedAt: new Date(Number(row.watched_at)).toISOString(),
      origin: row.origin ?? null,
    })),
  };
}

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
  const { showIdentity } = require('./canonicalIds');
  const identities: string[] = await mapWithConcurrency(keys, 8, (id: string) => showIdentity(id, config).catch(() => id));
  const groups = new Map<string, string[]>();
  keys.forEach((id, i) => groups.set(identities[i], [...(groups.get(identities[i]) ?? []), id]));
  const shows = [...groups.values()].map(preferredKey);
  droppedMemo.set(memo, shows);
  return shows;
}

function asProfile<T>(userUUID: string, profile: string | null, work: (config: any) => Promise<T>): Promise<T | null> {
  const { runInViewerScope } = require('./viewer');
  const { loadConfig } = require('./context');
  return runInViewerScope(false, async () => {
    const config = await loadConfig({ jellyfin: { userUUID, profileId: profile || null } }).catch(() => null);
    return config ? work(config) : null;
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
    const devices: Array<{ deviceId: string; client: string; device: string; version: string; lastSeen: number; playableMediaTypes: string[]; supportedCommands: string[] }> =
      await liveDevices(userUUID, profileKey(config));
    return devices.map((device) => ({
      deviceId: device.deviceId,
      client: device.client,
      device: device.device,
      version: device.version,
      lastSeen: device.lastSeen,
      canOpen: device.supportedCommands.includes('DisplayContent'),
      canPlay: device.playableMediaTypes.includes('Video'),
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

function playOf(data: any) {
  return {
    played: data?.Played === true,
    playCount: Number(data?.PlayCount) || 0,
    lastPlayedAt: data?.LastPlayedDate ? Date.parse(data.LastPlayedDate) || null : null,
    positionMs: Math.round((Number(data?.PlaybackPositionTicks) || 0) / TICKS_PER_MS),
  };
}

export async function dashboardTitle(userUUID: string, profile: string | null, ref: { item?: string; id?: string; type?: string }): Promise<any | null> {
  return asProfile(userUUID, profile, async (config) => {
    const itemId = titleItemId(ref);
    if (!itemId) return null;
    const { readTitle } = require('./index');
    const read = await readTitle(userUUID, config, itemId);
    if (!read) return null;
    const { meta, item, episodes, seasons: builtSeasons } = read;
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
    return {
      id: String(item.Id),
      metaId: String(meta.id),
      type: item.Type === 'Movie' ? 'movie' : 'series',
      title: meta.name ?? item.Name,
      year: meta.releaseInfo ? String(meta.releaseInfo) : meta.year ? String(meta.year) : null,
      overview: meta.description ?? null,
      genres: Array.isArray(meta.genres) ? meta.genres.map(String) : [],
      score: Number.isFinite(Number.parseFloat(meta.imdbRating)) ? String(meta.imdbRating) : null,
      runtime: meta.runtime ? String(meta.runtime) : null,
      status: item.Type === 'Movie' ? null : seriesStatus(meta) ?? null,
      posterUrl: meta.poster ?? null,
      backdropUrl: meta.background ?? null,
      logoUrl: meta.logo ?? null,
      ids: { imdb: meta.imdb_id ?? meta._imdbId ?? null, tmdb: meta._tmdbId ?? null, tvdb: meta._tvdbId ?? null },
      onWatchlist: item.UserData?.IsFavorite === true,
      dropped: item.UserData?.Likes === false,
      rating: Number.isFinite(Number(item.UserData?.Rating)) && item.UserData?.Rating !== null ? Number(item.UserData.Rating) : null,
      ...playOf(item.UserData),
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
    const { items, total } = await readPersonTitles(userUUID, config, personId, types, roles, from, Math.min(100, Math.max(1, limit)), ascending);
    const image = (id: unknown, tag: unknown): string | null =>
      id && tag ? `/jellyfin/${encodeURIComponent(userUUID)}/Items/${encodeURIComponent(String(id))}/Images/Primary?tag=${encodeURIComponent(String(tag))}` : null;
    return {
      offset: from,
      total,
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
    if (!config) return null;
    const { decodeJellyfinId } = require('./ids');
    const playstate = require('./playstate');
    for (const itemId of itemIds) {
      if (action === 'played') await playstate.recordPlayed(req, { ItemId: itemId });
      else if (action === 'unplayed') await playstate.recordUnplayed(req, { ItemId: itemId });
      else if (action === 'playedUpTo') await playstate.recordPlayedUpTo(req, itemId);
      else {
        const descriptor = await decodeJellyfinId(itemId);
        if (!descriptor) continue;
        if (action === 'watchlist' || action === 'unwatchlist') {
          const { setWatchlisted } = require('./watchlist');
          await setWatchlisted(userUUID, config, descriptor, action === 'watchlist');
        } else if (action === 'drop' || action === 'undrop') {
          const { rateSeries, clearLocalDrop } = require('./dropped');
          await rateSeries(userUUID, config, descriptor, action === 'drop' ? false : null);
          if (action === 'undrop') await clearLocalDrop(userUUID, config, descriptor.i).catch(() => false);
        } else if (action === 'rate') {
          const { rateItem, ratingFrom } = require('./ratings');
          await rateItem(userUUID, config, descriptor, ratingFrom(rating));
        }
      }
    }
    for (const key of [...showsMemo.keys()]) if (key.startsWith(`${userUUID}:`)) showsMemo.delete(key);
    for (const key of [...droppedMemo.keys()]) if (key.startsWith(`${userUUID}:`)) droppedMemo.delete(key);
    return true;
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
        results: metas.filter((meta) => meta?.id && !seen.has(String(meta.id)) && seen.add(String(meta.id))).slice(0, envInt('JELLYFIN_DASHBOARD_SEARCH_RESULTS', 12, 1) * 2).map((meta) => ({
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
