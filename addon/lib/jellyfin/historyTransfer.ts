import consola from 'consola';
import express from 'express';
import { envInt } from '../../utils/envNumber';
import { listProfiles } from './profiles';
import { ratingFrom } from './ratings';
import { openUpload, positive, type Ambiguous, type HistorySource, type Unmatched } from './historySources';
import { traktHistorySource } from './historySourceTrakt';
import { letterboxdHistorySource } from './historySourceLetterboxd';
import { stremioHistorySource } from './historySourceStremio';
import { listHistorySource } from './historySourceList';

const logger = consola.withTag('Jellyfin');
const database: any = require('../database');

export const HISTORY_FORMAT = 'aiometadata-history';
export const HISTORY_VERSION = 1;

type State = { positionMs: number; runtimeMs: number; played: boolean; playCount: number; lastPlayedAt: number | null; updatedAt: number; origin: string | null };
type PlaystateRow = State & { profile: string; videoId: string; title?: string };
type WatchRow = { profile: string; videoId: string; watchedAt: number; origin: string | null; title?: string };
type RatingRow = { profile: string; metaId: string; also?: string[]; rating: number; metaType: string | null; updatedAt: number };
type WatchlistRow = { profile: string; metaId: string; also?: string[]; mediaType: string; metaType: string | null; listed: boolean; updatedAt: number };
type DroppedRow = { profile: string; metaId: string; also?: string[]; updatedAt: number };
type MatchRow = { service: string; base: string; group: string; data: string };

export type HistoryFile = {
  profiles: Array<{ key: string; name: string }>;
  playstate: PlaystateRow[];
  watches: WatchRow[];
  ratings: RatingRow[];
  watchlist: WatchlistRow[];
  dropped: DroppedRow[];
  matches: MatchRow[];
};

type Section = 'playstate' | 'watches' | 'ratings' | 'watchlist' | 'dropped' | 'matches';
type Counts = Record<Section, { added: number; updated: number; unchanged: number }>;

const SECTIONS: Section[] = ['playstate', 'watches', 'ratings', 'watchlist', 'dropped', 'matches'];
const MEDIA_TYPES = new Set(['movie', 'series', 'anime']);
const META_TYPES = new Set(['movie', 'series']);
const MAX_ID = 256;
const MAX_PROFILE = 64;
const MAX_NAME = 100;
const MAX_MATCH_DATA = 65536;
const MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PLAYS = 10000;
const MAX_SPELLINGS = 16;
const TOKEN = /^[A-Za-z0-9_-]{1,32}$/;
const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/;

const iso = (value: unknown): string | null => {
  const at = Number(value);
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null;
};

const latestAllowed = () => Date.now() + envInt('JELLYFIN_HISTORY_IMPORT_FUTURE_HOURS', 24, 0) * 60 * 60 * 1000;

const idOf = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_ID && PRINTABLE.test(value) ? value : null;

const profileOf = (value: unknown): string | null =>
  value === undefined || value === null ? '' : typeof value === 'string' && value.length <= MAX_PROFILE && PRINTABLE.test(value) ? value : null;

const tokenOf = (value: unknown): string | null => (typeof value === 'string' && TOKEN.test(value) ? value : null);

const titleOf = (value: unknown): string | undefined => idOf(value) ?? undefined;

const alsoOf = (value: unknown, metaId: string): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const ids = [...new Set(value.map(idOf).filter((id): id is string => Boolean(id) && id !== metaId))].slice(0, MAX_SPELLINGS);
  return ids.length ? ids : undefined;
};

const amount = (value: unknown, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.round(n)) : 0;
};

export function historyProfiles(config: any, userUUID: string): Array<{ key: string; name: string }> {
  return listProfiles(config, userUUID)
    .filter((profile) => !profile.id || !profile.sharesHistory)
    .map((profile) => ({ key: profile.id ?? '', name: profile.name }));
}

export async function buildHistoryExport(userUUID: string, config: any): Promise<any> {
  const [playstate, watches, ratings, watchlist, dropped, matches] = await Promise.all([
    database.listPlaystateFor(userUUID),
    database.listWatchesForConfiguration(userUUID),
    database.listRatingsForConfiguration(userUUID),
    database.listWatchlistForConfiguration(userUUID),
    database.listDroppedForConfiguration(userUUID),
    database.listTrackerMatchesForConfiguration(userUUID),
  ]);
  return {
    format: HISTORY_FORMAT,
    version: HISTORY_VERSION,
    exportedAt: new Date().toISOString(),
    profiles: config ? historyProfiles(config, userUUID) : [],
    playstate: playstate.map((row: any) => ({
      profile: String(row.profile ?? ''),
      videoId: String(row.video_id),
      positionMs: Number(row.position_ms) || 0,
      runtimeMs: Number(row.runtime_ms) || 0,
      played: Boolean(row.played),
      playCount: Number(row.play_count) || 0,
      lastPlayedAt: iso(row.last_played_at),
      updatedAt: iso(row.updated_at),
      origin: row.origin ?? null,
    })),
    watches: watches.map((row: any) => ({
      profile: String(row.profile ?? ''),
      videoId: String(row.video_id),
      watchedAt: iso(row.watched_at),
      origin: row.origin ?? null,
    })),
    ratings: ratings.map((row: any) => ({
      profile: String(row.profile ?? ''),
      metaId: String(row.meta_id),
      rating: Number(row.rating),
      metaType: row.meta_type ?? null,
      updatedAt: iso(row.updated_at),
    })),
    watchlist: watchlist.map((row: any) => ({
      profile: String(row.profile ?? ''),
      metaId: String(row.meta_id),
      mediaType: String(row.media_type),
      metaType: row.meta_type ?? null,
      listed: Boolean(Number(row.listed)),
      updatedAt: iso(row.updated_at),
    })),
    dropped: dropped.map((row: any) => ({
      profile: String(row.profile ?? ''),
      metaId: String(row.meta_id),
      updatedAt: iso(row.updated_at),
    })),
    matches: matches.map((row: any) => {
      let data: any = row.data;
      try {
        data = JSON.parse(String(row.data));
      } catch {
        data = String(row.data);
      }
      return { service: String(row.service), base: String(row.base), group: String(row.match_group), data };
    }),
  };
}

export function readHistoryFile(body: any): HistoryFile | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'This is not a watch history export';
  const list = (value: unknown): any[] => (Array.isArray(value) ? value : []);
  const latest = latestAllowed();
  const epoch = (value: unknown): number | null => {
    const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(at) && at > 0 && at <= latest ? Math.round(at) : null;
  };
  const out: HistoryFile = { profiles: [], playstate: [], watches: [], ratings: [], watchlist: [], dropped: [], matches: [] };

  let rows: any[];
  let originOf: (row: any) => string | null;
  let runtimeOf: (row: any) => unknown;
  if (body.format === HISTORY_FORMAT) {
    if (!(Number(body.version) >= 1)) return 'This export has no version this server can read';
    if (Number(body.version) > HISTORY_VERSION) return 'This export is from a newer version of AIOMetadata. Update this server first.';
    rows = list(body.playstate);
    originOf = (row) => tokenOf(row.origin);
    runtimeOf = (row) => row.runtimeMs;
    for (const row of list(body.profiles)) out.profiles.push({ key: profileOf(row?.key) ?? '', name: row?.name });
  } else if (body.format === undefined && Array.isArray(body.rows) && Array.isArray(body.users)) {
    rows = body.rows;
    originOf = (row) => (row.origin === 'local' ? 'server' : null);
    runtimeOf = (row) => row.durationMs;
    for (const user of body.users) out.profiles.push({ key: profileOf(user?.profile) ?? '', name: user?.name });
  } else if (body.format === undefined && Array.isArray(body.rows) && typeof body.userUUID === 'string') {
    rows = body.rows;
    originOf = (row) => tokenOf(row.origin);
    runtimeOf = (row) => row.runtimeMs;
    for (const row of list(body.profiles)) out.profiles.push({ key: profileOf(row?.key) ?? '', name: row?.name });
  } else {
    return 'This is not a watch history export';
  }
  out.profiles = out.profiles
    .filter((profile, index, all) => all.findIndex((other) => other.key === profile.key) === index)
    .map((profile) => {
      const name = typeof profile.name === 'string' && PRINTABLE.test(profile.name) ? profile.name.trim().slice(0, MAX_NAME) : '';
      return { key: profile.key, name: name || (profile.key ? profile.key.slice(0, 8) : 'Main') };
    });

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const profile = profileOf(row.profile);
    const videoId = idOf(row.videoId);
    const updatedAt = epoch(row.updatedAt);
    if (profile === null || !videoId || !updatedAt) continue;
    out.playstate.push({
      profile, videoId, updatedAt,
      positionMs: amount(row.positionMs, MAX_MS), runtimeMs: amount(runtimeOf(row), MAX_MS), played: row.played === true,
      playCount: amount(row.playCount, MAX_PLAYS), lastPlayedAt: epoch(row.lastPlayedAt), origin: originOf(row), title: titleOf(row.title),
    });
  }
  for (const row of list(body.watches)) {
    const profile = profileOf(row?.profile);
    const videoId = idOf(row?.videoId);
    const watchedAt = epoch(row?.watchedAt);
    if (profile !== null && videoId && watchedAt) out.watches.push({ profile, videoId, watchedAt, origin: tokenOf(row.origin), title: titleOf(row.title) });
  }
  for (const row of list(body.ratings)) {
    const profile = profileOf(row?.profile);
    const metaId = idOf(row?.metaId);
    const rating = ratingFrom(row?.rating);
    const updatedAt = epoch(row?.updatedAt);
    if (profile !== null && metaId && rating !== null && updatedAt) {
      out.ratings.push({ profile, metaId, also: alsoOf(row.also, metaId), rating, metaType: META_TYPES.has(row.metaType) ? row.metaType : null, updatedAt });
    }
  }
  for (const row of list(body.watchlist)) {
    const profile = profileOf(row?.profile);
    const metaId = idOf(row?.metaId);
    const updatedAt = epoch(row?.updatedAt);
    if (profile !== null && metaId && MEDIA_TYPES.has(row.mediaType) && updatedAt) {
      out.watchlist.push({ profile, metaId, also: alsoOf(row.also, metaId), mediaType: row.mediaType, metaType: META_TYPES.has(row.metaType) ? row.metaType : null, listed: row.listed !== false, updatedAt });
    }
  }
  for (const row of list(body.dropped)) {
    const profile = profileOf(row?.profile);
    const metaId = idOf(row?.metaId);
    const updatedAt = epoch(row?.updatedAt);
    if (profile !== null && metaId && updatedAt) out.dropped.push({ profile, metaId, also: alsoOf(row.also, metaId), updatedAt });
  }
  for (const row of list(body.matches)) {
    const service = tokenOf(row?.service);
    const base = idOf(row?.base);
    const group = idOf(row?.group);
    const data = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? JSON.stringify(row.data) : null;
    if (service && base && group && data && data.length <= MAX_MATCH_DATA) out.matches.push({ service, base, group, data });
  }
  return out;
}

const stateOf = (row: any): State => ({
  positionMs: Number(row.position_ms) || 0,
  runtimeMs: Number(row.runtime_ms) || 0,
  played: Boolean(Number(row.played)),
  playCount: Number(row.play_count) || 0,
  lastPlayedAt: row.last_played_at ? Number(row.last_played_at) : null,
  updatedAt: Number(row.updated_at) || 0,
  origin: row.origin ?? null,
});

const LOCAL_ORIGINS = new Set(['server', 'play']);

function mergeState(held: State, incoming: State): State {
  const newer = incoming.updatedAt > held.updatedAt ? incoming : held;
  return {
    positionMs: newer.positionMs,
    runtimeMs: newer.runtimeMs || Math.max(held.runtimeMs, incoming.runtimeMs),
    played: newer.played,
    playCount: Math.max(held.playCount, incoming.playCount),
    lastPlayedAt: Math.max(held.lastPlayedAt ?? 0, incoming.lastPlayedAt ?? 0) || null,
    updatedAt: Math.max(held.updatedAt, incoming.updatedAt),
    // A row holding a play made here stays this server's, or forgetting the import would take that play with it.
    origin: LOCAL_ORIGINS.has(String(held.origin)) ? held.origin : newer.origin,
  };
}

const sameState = (a: State, b: State) => (Object.keys(a) as Array<keyof State>).every((field) => a[field] === b[field]);

type Write = () => Promise<unknown>;

type Plan = { counts: Counts; writes: Write[] };

const emptyCounts = (): Counts => Object.fromEntries(SECTIONS.map((section) => [section, { added: 0, updated: 0, unchanged: 0 }])) as Counts;

const keyOf = (profile: string, id: string) => `${profile}\u0000${id}`;

const nativeSameWatchMs = () => envInt('JELLYFIN_HISTORY_IMPORT_SAME_WATCH_SECONDS', 60, 0) * 1000;

export async function planHistoryImport(userUUID: string, file: HistoryFile, mapping: Record<string, string | null>, sameWatchMs = nativeSameWatchMs(), sameStateMs = sameWatchMs, skip: ReadonlySet<Section> = new Set()): Promise<Plan> {
  const counts = emptyCounts();
  const writes: Write[] = [];
  const queue = (section: Section, write: Write) => {
    if (!skip.has(section)) writes.push(write);
  };
  const target = (profile: string): string | null => (Object.prototype.hasOwnProperty.call(mapping, profile) && typeof mapping[profile] === 'string' ? mapping[profile] : null);

  const [playstate, watches, ratings, watchlist, dropped, matches] = await Promise.all([
    database.listPlaystateFor(userUUID),
    database.listWatchesForConfiguration(userUUID),
    database.listRatingsForConfiguration(userUUID),
    database.listWatchlistForConfiguration(userUUID),
    database.listDroppedForConfiguration(userUUID),
    database.listTrackerMatchesForConfiguration(userUUID),
  ]);

  const incomingStates = new Map<string, { profile: string; videoId: string; title: string; state: State }>();
  for (const row of file.playstate) {
    const profile = target(row.profile);
    if (profile === null) continue;
    const key = keyOf(profile, row.videoId);
    const { profile: _profile, videoId, title, ...state } = row;
    const prior = incomingStates.get(key);
    incomingStates.set(key, { profile, videoId, title: keyOf(profile, title ?? videoId), state: prior ? mergeState(prior.state, state) : state });
  }
  const heldStates = new Map<string, State>(playstate.map((row: any) => [keyOf(String(row.profile ?? ''), String(row.video_id)), stateOf(row)]));
  const titles = new Map<string, Array<{ key: string; profile: string; videoId: string; state: State }>>();
  for (const [key, { title, ...entry }] of incomingStates) {
    if (!titles.has(title)) titles.set(title, []);
    titles.get(title)!.push({ key, ...entry });
  }
  // A finish near a held pause is that viewing ending, so it keeps its own, newer times.
  const sameViewing = (held: State, state: State): State =>
    (held.played || !state.played) && held.lastPlayedAt && state.lastPlayedAt && Math.abs(held.lastPlayedAt - state.lastPlayedAt) <= sameStateMs
      ? { ...state, lastPlayedAt: held.lastPlayedAt, updatedAt: Math.min(state.updatedAt, held.updatedAt) }
      : state;
  const mergedInto = (held: State, state: State) => mergeState(held, sameViewing(held, state));
  for (const spellings of titles.values()) {
    const held = spellings.filter((spelling) => heldStates.has(spelling.key));
    const due = held.length ? held.filter((spelling) => !sameState(mergedInto(heldStates.get(spelling.key)!, spelling.state), heldStates.get(spelling.key)!)) : spellings;
    if (!due.length) {
      counts.playstate.unchanged += 1;
      continue;
    }
    counts.playstate[held.length ? 'updated' : 'added'] += 1;
    for (const { profile, videoId, state } of due) {
      queue('playstate', async () => {
        const current = await database.currentPlaystate(userUUID, profile, videoId);
        const next = current ? mergedInto(stateOf(current), state) : state;
        if (current && sameState(next, stateOf(current))) return;
        await database.writePlaystateRow(userUUID, profile, videoId, next);
      });
    }
  }

  const viewings = new Map<string, number[]>();
  for (const row of watches) {
    const key = keyOf(String(row.profile ?? ''), String(row.video_id));
    if (!viewings.has(key)) viewings.set(key, []);
    viewings.get(key)!.push(Number(row.watched_at));
  }
  const moments = new Map<string, { profile: string; watchedAt: number; origin: string | null; videoIds: string[] }>();
  for (const row of file.watches) {
    const profile = target(row.profile);
    if (profile === null) continue;
    const key = `${keyOf(profile, row.title ?? row.videoId)}\u0000${row.watchedAt}`;
    const moment = moments.get(key) ?? { profile, watchedAt: row.watchedAt, origin: row.origin, videoIds: [] };
    if (!moment.videoIds.includes(row.videoId)) moment.videoIds.push(row.videoId);
    moments.set(key, moment);
  }
  // A file's viewings are matched against the history held before it, not against one another: the source already
  // decided which of its rows are separate viewings.
  const added = new Map<string, number[]>();
  for (const { profile, watchedAt, origin, videoIds } of moments.values()) {
    const near = videoIds.some((videoId) => (viewings.get(keyOf(profile, videoId)) ?? []).some((at) => Math.abs(at - watchedAt) <= sameWatchMs));
    if (near) {
      counts.watches.unchanged += 1;
      continue;
    }
    for (const videoId of videoIds) {
      const key = keyOf(profile, videoId);
      added.set(key, [...(added.get(key) ?? []), watchedAt]);
    }
    counts.watches.added += 1;
    queue('watches', async () => {
      for (const videoId of videoIds) if (await database.hasWatchNear(userUUID, profile, videoId, watchedAt, sameWatchMs, added.get(keyOf(profile, videoId)))) return;
      for (const videoId of videoIds) await database.insertWatch(userUUID, profile, videoId, watchedAt, origin);
    });
  }

  const newestPer = <T extends { profile: string; metaId: string; updatedAt: number }>(rows: T[]): Map<string, T & { target: string }> => {
    const out = new Map<string, T & { target: string }>();
    for (const row of rows) {
      const profile = target(row.profile);
      if (profile === null) continue;
      const key = keyOf(profile, row.metaId);
      const prior = out.get(key);
      if (!prior || row.updatedAt > prior.updatedAt) out.set(key, { ...row, target: profile });
    }
    return out;
  };

  const spellingsOf = (row: { metaId: string; also?: string[] }) => [row.metaId, ...(row.also ?? [])];

  const sameKind = (held: any, metaType: string | null) => !held?.meta_type || !metaType || held.meta_type === metaType;

  const heldRatings = new Map<string, any>(ratings.map((row: any) => [keyOf(String(row.profile ?? ''), String(row.meta_id)), row]));
  const ratingKept = (held: any, row: RatingRow) => Number(held.rating) === row.rating || Number(held.updated_at) >= row.updatedAt;
  for (const row of newestPer(file.ratings).values()) {
    // A TMDB number names a film and a show alike, so a spelling the other kind holds is neither its mark nor free to write.
    const ids = spellingsOf(row).filter((id) => sameKind(heldRatings.get(keyOf(row.target, id)), row.metaType));
    const held = ids.map((id) => heldRatings.get(keyOf(row.target, id))).filter(Boolean);
    if (!ids.length || held.some((mark) => ratingKept(mark, row))) {
      counts.ratings.unchanged += 1;
      continue;
    }
    counts.ratings[held.length ? 'updated' : 'added'] += 1;
    queue('ratings', async () => {
      for (const id of ids) {
        const current = await database.currentMark('jellyfin_ratings', userUUID, row.target, id);
        if (current && sameKind(current, row.metaType) && ratingKept(current, row)) return;
      }
      await database.setRating(userUUID, row.target, ids, row.rating, row.metaType, row.updatedAt);
    });
  }

  const heldListed = new Map<string, any>(watchlist.map((row: any) => [keyOf(String(row.profile ?? ''), String(row.meta_id)), row]));
  const listingKept = (held: any, row: WatchlistRow) => (held ? Boolean(Number(held.listed)) === row.listed || Number(held.updated_at) >= row.updatedAt : !row.listed);
  for (const row of newestPer(file.watchlist).values()) {
    const ids = spellingsOf(row).filter((id) => sameKind(heldListed.get(keyOf(row.target, id)), row.metaType));
    if (!ids.length) {
      counts.watchlist.unchanged += 1;
      continue;
    }
    const heldId = ids.find((id) => heldListed.has(keyOf(row.target, id)));
    const held = heldId ? heldListed.get(keyOf(row.target, heldId)) : undefined;
    if (listingKept(held, row)) {
      counts.watchlist.unchanged += 1;
      continue;
    }
    counts.watchlist[held ? 'updated' : 'added'] += 1;
    const metaId = heldId ?? ids[0];
    queue('watchlist', async () => {
      const current = await database.currentMark('jellyfin_watchlist', userUUID, row.target, metaId);
      if (listingKept(current, row)) return;
      await database.setWatchlisted(userUUID, row.target, metaId, row.mediaType, row.listed, row.metaType, row.updatedAt);
    });
  }

  const heldDrops = new Set<string>(dropped.map((row: any) => keyOf(String(row.profile ?? ''), String(row.meta_id))));
  for (const row of newestPer(file.dropped).values()) {
    const ids = spellingsOf(row);
    if (ids.some((id) => heldDrops.has(keyOf(row.target, id)))) {
      counts.dropped.unchanged += 1;
      continue;
    }
    for (const id of ids) heldDrops.add(keyOf(row.target, id));
    counts.dropped.added += 1;
    queue('dropped', async () => {
      for (const id of ids) if (await database.currentMark('jellyfin_dropped', userUUID, row.target, id)) return;
      await database.setDropped(userUUID, row.target, ids, true, row.updatedAt);
    });
  }

  const heldMatches = new Set<string>(matches.flatMap((row: any) => [keyOf(String(row.service), String(row.base)), keyOf(String(row.service), `group\u0000${row.match_group}`)]));
  const groups = new Map<string, { service: string; group: string; data: string; bases: string[] }>();
  for (const row of file.matches) {
    const key = keyOf(row.service, row.group);
    if (!groups.has(key)) groups.set(key, { service: row.service, group: row.group, data: row.data, bases: [] });
    const group = groups.get(key)!;
    if (!group.bases.includes(row.base)) group.bases.push(row.base);
  }
  for (const { service, group, data, bases } of groups.values()) {
    if (heldMatches.has(keyOf(service, `group\u0000${group}`)) || bases.some((base) => heldMatches.has(keyOf(service, base)))) {
      counts.matches.unchanged += 1;
      continue;
    }
    heldMatches.add(keyOf(service, `group\u0000${group}`));
    for (const base of bases) heldMatches.add(keyOf(service, base));
    counts.matches.added += 1;
    queue('matches', async () => {
      if (await database.trackerMatchHeld(userUUID, service, group, bases)) return;
      await database.saveTrackerMatch(userUUID, service, group, bases, data);
      require('./trackerMatch').forgetMatches(userUUID, service);
    });
  }

  return { counts, writes };
}

const staleMs = () => envInt('JELLYFIN_HISTORY_IMPORT_STALE_SECONDS', 60, 10) * 1000;

function forgetLocalCaches(userUUID: string): void {
  const { invalidateResume, invalidateDatedShelves } = require('./resume');
  const { invalidateWatchlist } = require('./watchlist');
  const { forgetHeldDrops } = require('./dropped');
  const { forgetDashboardStats } = require('./dashboard');
  invalidateResume(userUUID);
  invalidateDatedShelves(userUUID);
  invalidateWatchlist(userUUID);
  forgetHeldDrops(userUUID);
  void forgetDashboardStats(userUUID);
}

async function runImport(userUUID: string, plan: Plan, startedAt: number): Promise<void> {
  const beatMs = Math.max(1000, Math.floor(staleMs() / 6));
  let done = 0;
  let beat = Date.now();
  try {
    for (const write of plan.writes) {
      await write();
      done += 1;
      if (Date.now() - beat >= beatMs) {
        beat = Date.now();
        if (!(await database.updateHistoryImport(userUUID, startedAt, { done, heartbeatAt: beat }))) {
          logger.warn(`History import into ${userUUID} was taken over after ${done}/${plan.writes.length} write(s)`);
          return;
        }
      }
    }
    const at = Date.now();
    await database.updateHistoryImport(userUUID, startedAt, { status: 'done', done, heartbeatAt: at, finishedAt: at });
    logger.info(`Imported history into ${userUUID}: ${done} write(s)`);
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 500);
    const at = Date.now();
    await database.updateHistoryImport(userUUID, startedAt, { status: 'failed', done, error: message, heartbeatAt: at, finishedAt: at }).catch(() => undefined);
    logger.warn(`History import into ${userUUID} stopped after ${done}/${plan.writes.length} write(s): ${message}`);
  } finally {
    forgetLocalCaches(userUUID);
  }
}

export async function startHistoryImport(userUUID: string, plan: Plan, fileName: string | null): Promise<boolean> {
  const startedAt = Date.now();
  const claimed = await database.claimHistoryImport(userUUID, {
    fileName,
    total: plan.writes.length,
    counts: JSON.stringify(plan.counts),
    startedAt,
    staleBefore: startedAt - staleMs(),
  });
  if (!claimed) return false;
  void runImport(userUUID, plan, startedAt);
  return true;
}

export async function historyImportStatus(userUUID: string): Promise<any | null> {
  const row = await database.getHistoryImport(userUUID);
  if (!row) return null;
  const interrupted = row.status === 'running' && Number(row.heartbeat_at) < Date.now() - staleMs();
  let counts: any = null;
  try {
    counts = row.counts ? JSON.parse(row.counts) : null;
  } catch {
    counts = null;
  }
  return {
    status: interrupted ? 'interrupted' : row.status,
    fileName: row.file_name ?? null,
    done: Number(row.done) || 0,
    total: Number(row.total) || 0,
    counts,
    error: row.error ?? null,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

export async function dismissHistoryImport(userUUID: string): Promise<boolean> {
  const job = await historyImportStatus(userUUID);
  if (job?.status === 'running') return false;
  await database.deleteHistoryImport(userUUID);
  return true;
}

const rawParsers = new Map<string, any>();

export function historyImportBody(): any {
  const limit = `${envInt('JELLYFIN_HISTORY_IMPORT_MAX_MB', 64, 1)}mb`;
  let parser = rawParsers.get(limit);
  if (!parser) {
    parser = express.raw({ type: 'application/octet-stream', limit });
    rawParsers.set(limit, parser);
  }
  return parser;
}

const nativeHistorySource: HistorySource = {
  id: 'aiometadata',
  about: 'Nothing already here is lost: the newer state of each title wins, and a viewing already in the history is not added twice. Nothing is sent to the trackers now; what they lack shows in the Trackers section, to send or leave out.',
  sameViewingMs: nativeSameWatchMs,
  detects: (upload) => upload.json !== undefined,
  read: async (upload) => ({ body: upload.json, unmatched: [], unmatchedCount: 0 }),
};

const HISTORY_SOURCES: HistorySource[] = [listHistorySource, traktHistorySource, letterboxdHistorySource, stremioHistorySource, nativeHistorySource];

export function importedOrigins(): Map<string, string> {
  return new Map(HISTORY_SOURCES.filter((source) => source.importName).map((source) => [source.id, source.importName!]));
}

type Received = { file: HistoryFile; source: HistorySource; unmatched: Unmatched[]; unmatchedCount: number; ambiguous: Ambiguous[] };

const MAX_PICKS = 500;

function picksOf(value: unknown): Record<string, number> | null {
  if (value === undefined) return Object.create(null);
  let asked: any;
  try {
    asked = JSON.parse(String(value));
  } catch {
    return null;
  }
  const picks: Record<string, number> = Object.create(null);
  if (!asked || typeof asked !== 'object' || Array.isArray(asked)) return picks;
  for (const [key, tmdb] of Object.entries(asked).slice(0, MAX_PICKS)) {
    if (/^[0-9a-f]{16}$/.test(key) && positive(tmdb)) picks[key] = positive(tmdb)!;
  }
  return picks;
}

const refused = (error: string) => ({ status: 400, body: { error } });

function skippedOf(value: unknown): Set<Section> {
  const asked = typeof value === 'string' ? value.split(',') : [];
  return new Set(SECTIONS.filter((section) => asked.includes(section)));
}

async function readUpload(userUUID: string, config: any, buffer: Buffer, fileName: string | null, picks: Record<string, number>): Promise<Received | { status: number; body: any }> {
  const upload = openUpload(buffer, fileName);
  if (typeof upload === 'string') return refused(upload);
  const source = HISTORY_SOURCES.find((candidate) => candidate.detects(upload));
  if (!source) return refused(upload.files.size > 1 ? 'This zip file is not a watch history export this server can read' : 'This file is not valid JSON');
  const read = await source.read(upload, { userUUID, config, picks });
  if (typeof read === 'string') return refused(read);
  if ('matching' in read) return { status: 202, body: read };
  const file = readHistoryFile(read.body);
  return typeof file === 'string' ? refused(file) : { file, source, unmatched: read.unmatched, unmatchedCount: read.unmatchedCount, ambiguous: read.ambiguous ?? [] };
}

export async function receiveHistoryImport(userUUID: string, config: any, body: unknown, query: any): Promise<{ status: number; body: any }> {
  const fileName = typeof query?.name === 'string' && PRINTABLE.test(query.name) ? query.name.slice(0, 200) : null;
  const picks = picksOf(query?.picks);
  if (!picks) return { status: 400, body: { error: 'The film choices could not be read' } };
  const upload = await readUpload(userUUID, config, Buffer.isBuffer(body) ? body : Buffer.alloc(0), fileName, picks);
  if ('status' in upload) return upload;
  const { file } = upload;

  const targets = historyProfiles(config, userUUID);
  const sources = new Map<string, string>(file.profiles.map((profile) => [profile.key, profile.name]));
  for (const section of [file.playstate, file.watches, file.ratings, file.watchlist, file.dropped]) {
    for (const row of section) if (!sources.has(row.profile)) sources.set(row.profile, row.profile ? row.profile.slice(0, 8) : 'Main');
  }

  const mapping: Record<string, string | null> = Object.create(null);
  if (typeof query?.map === 'string') {
    let asked: any;
    try {
      asked = JSON.parse(query.map);
    } catch {
      return { status: 400, body: { error: 'The user choice could not be read' } };
    }
    const known = new Set(targets.map((profile) => profile.key));
    for (const key of sources.keys()) {
      const to = asked && typeof asked === 'object' && Object.prototype.hasOwnProperty.call(asked, key) ? asked[key] : null;
      mapping[key] = typeof to === 'string' && known.has(to) ? to : null;
    }
  } else {
    for (const [key, name] of sources) {
      const byKey = targets.find((profile) => profile.key === key);
      const byName = targets.find((profile) => profile.name.toLowerCase() === name.toLowerCase());
      mapping[key] = (byKey ?? byName)?.key ?? (key === '' ? '' : null);
    }
  }

  const skipped = skippedOf(query?.skip);
  const plan = await planHistoryImport(userUUID, file, mapping, upload.source.sameViewingMs(), upload.source.sameStateMs?.() ?? upload.source.sameViewingMs(), skipped);
  const summary = {
    source: upload.source.id,
    about: upload.source.about,
    sources: [...sources].map(([key, name]) => ({ key, name })),
    targets,
    mapping,
    counts: plan.counts,
    writes: plan.writes.length,
    skipped: [...skipped],
    unmatched: upload.unmatched,
    unmatchedCount: upload.unmatchedCount,
    ambiguous: upload.ambiguous,
  };
  if (query?.apply !== '1') return { status: 200, body: summary };
  if (!(await startHistoryImport(userUUID, plan, fileName))) return { status: 409, body: { error: 'An import is already running for this configuration' } };
  return { status: 202, body: { ...summary, job: await historyImportStatus(userUUID) } };
}
