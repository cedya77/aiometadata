import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { trackerConfig, type AccountService } from '../accounts';
import { videoIdAliases } from './aliases';
import { scopeConfigToProfile } from './profiles';
import { credentialFor, type Capable } from './trackerSource';
import { asListed, belongsOn, pullDrift, spellingFor, spellingsFor, viewingOf, type Viewing } from './trackerDrift';
import { MARKS, markBatchSize, markVideo, planMarks, writeMarks, type Mark, type MarkItem } from './trackerMarks';

const logger = consola.withTag('Trackers');
const database: any = require('../database');

const ANIME_LISTS = new Set<string>(['anilist', 'mal']);
export const COPY_SOURCES = new Set<string>(['simkl', 'mdblist', 'publicmetadb']);
const NAMES: Record<string, string> = { simkl: 'Simkl', mdblist: 'MDBList', publicmetadb: 'PublicMetaDB', anilist: 'AniList', mal: 'MyAnimeList' };
const NOUNS: Record<string, [string, string]> = { watches: ['watch', 'watches'], ratings: ['rating', 'ratings'], watchlist: ['watchlist title', 'watchlist titles'], dropped: ['dropped show', 'dropped shows'] };
export type CopyWhat = 'watches' | Mark;

export interface CopySide {
  service: Capable;
  credential: string;
  key: string;
  keys: Set<string>;
  scoped: any;
}

export interface CopyItem {
  ids: string[];
  kind: 'movie' | 'episode';
  metaId: string;
  season: number | null;
  episode: number | null;
  at: number | null;
  native?: { tmdb: number; imdb: string | null; season: number | null; episode: number | null };
}

const TMDB_NUMBERED = new Set<string>(['mdblist', 'publicmetadb']);

const nativeKey = (kind: string, tmdb: number, season: number | null, episode: number | null) => (kind === 'movie' ? `movie:${tmdb}` : `tv:${tmdb}:${season}:${episode}`);
const dateOf = (value: unknown): number | null => {
  const at = Date.parse(String(value ?? '').replace(' ', 'T'));
  return Number.isFinite(at) ? at : null;
};

async function nativeEntries(service: string, credential: string, config: any): Promise<CopyItem[]> {
  const { mirrorRows } = require('./trackerMirror');
  const { movieSpellings } = require('./watched');
  const rows: Array<{ key: string; data: any }> = await mirrorRows(service, credential);
  const byKey = new Map<string, CopyItem>();
  const add = async (kind: 'movie' | 'episode', tmdb: number, imdb: string | null, season: number | null, episode: number | null, at: number | null, spellings: string[]) => {
    if (!Number.isFinite(tmdb) || tmdb <= 0) return;
    const key = nativeKey(kind, tmdb, season, episode);
    const held = byKey.get(key);
    if (held) {
      if ((at ?? 0) > (held.at ?? 0)) held.at = at;
      return;
    }
    const ids = new Set(spellings);
    for (const spelling of spellings) for (const alias of await videoIdAliases(spelling).catch(() => [] as string[])) ids.add(alias);
    if (kind === 'movie') for (const spelling of spellings) for (const more of await movieSpellings(spelling, config)) ids.add(more);
    const list = [...ids];
    byKey.set(key, { ids: list, kind, metaId: kind === 'movie' ? list[0] : imdb ?? `tmdb:${tmdb}`, season, episode, at, native: { tmdb, imdb, season, episode } });
  };
  for (const row of rows) {
    const data = row.data;
    if (service === 'mdblist' && row.key.startsWith('movie:')) {
      const ids = data?.movie?.ids ?? {};
      await add('movie', Number(ids.tmdb), ids.imdb ?? null, null, null, dateOf(data?.last_watched_at), [ids.imdb, `tmdb:${ids.tmdb}`].filter((id) => id && !String(id).endsWith(':undefined')));
    } else if (service === 'mdblist' && row.key.startsWith('ep:')) {
      const show = data?.episode?.show?.ids ?? {};
      const season = Number(data?.episode?.season);
      const episode = Number(data?.episode?.number);
      const named = data?.episode?.tvdb_ids;
      const spellings: string[] = [];
      if (named?.series && Number.isFinite(Number(named.season)) && Number.isFinite(Number(named.episode))) {
        spellings.push(`tvdb:${named.series}:${named.season}:${named.episode}`);
        if (show.imdb && String(show.tvdb ?? '') === String(named.series)) spellings.push(`${show.imdb}:${named.season}:${named.episode}`);
      } else if (show.imdb) {
        spellings.push(`${show.imdb}:${season}:${episode}`);
      }
      spellings.push(`tmdb:${show.tmdb}:${season}:${episode}`);
      await add('episode', Number(show.tmdb), show.imdb ?? null, season, episode, dateOf(data?.last_watched_at), spellings);
    } else if (service === 'publicmetadb' && row.key.startsWith('play:')) {
      const kind = data?.media_type === 'movie' ? 'movie' : 'episode';
      const tmdb = Number(data?.tmdb_id);
      await add(kind, tmdb, null, kind === 'movie' ? null : Number(data?.season), kind === 'movie' ? null : Number(data?.episode), dateOf(data?.watched_at), [kind === 'movie' ? `tmdb:${tmdb}` : `tmdb:${tmdb}:${data?.season}:${data?.episode}`]);
    }
  }
  return [...byKey.values()];
}

async function nativeHeld(service: string, credential: string): Promise<Set<string>> {
  const { mirrorRows } = require('./trackerMirror');
  const rows: Array<{ key: string; data: any }> = await mirrorRows(service, credential);
  const out = new Set<string>();
  for (const { key, data } of rows) {
    if (service === 'mdblist' && key.startsWith('movie:')) out.add(nativeKey('movie', Number(data?.movie?.ids?.tmdb), null, null));
    if (service === 'mdblist' && key.startsWith('ep:')) out.add(nativeKey('episode', Number(data?.episode?.show?.ids?.tmdb), Number(data?.episode?.season), Number(data?.episode?.number)));
    if (service === 'mdblist' && key.startsWith('ep:') && data?.episode?.show?.ids?.imdb) out.add(`imdb:${data.episode.show.ids.imdb}:${data.episode.season}:${data.episode.number}`);
    const tvdbNumbers = service === 'mdblist' && key.startsWith('ep:') ? data?.episode?.tvdb_ids : null;
    if (tvdbNumbers?.series) out.add(`tvdb:${tvdbNumbers.series}:${tvdbNumbers.season}:${tvdbNumbers.episode}`);
    if (service === 'mdblist' && key.startsWith('movie:') && data?.movie?.ids?.imdb) out.add(`imdb:${data.movie.ids.imdb}`);
    if (service === 'publicmetadb' && key.startsWith('play:')) out.add(data?.media_type === 'movie' ? nativeKey('movie', Number(data?.tmdb_id), null, null) : nativeKey('episode', Number(data?.tmdb_id), Number(data?.season), Number(data?.episode)));
  }
  return out;
}

export interface CopyPlan {
  items: CopyItem[];
  excluded: number;
  blocked: { noId: number; refused: number };
  checkedAt: number;
}

const copyKey = (item: { metaId: string; season?: number | null; episode?: number | null }) => `${item.metaId}|${item.season ?? ''}|${item.episode ?? ''}`;

async function triedBefore(userUUID: string, from: CopySide, to: CopySide, what: CopyWhat, retry: boolean): Promise<Set<string>> {
  if (retry) return new Set();
  const items: any[] = await database.copiedBefore(userUUID, from.key, to.key, what).catch(() => []);
  return new Set(items.map(copyKey));
}

const SIMKL_KEYS = ['simkl', 'imdb', 'tmdb', 'tvdb', 'mal', 'anidb', 'kitsu', 'anilist'];

async function simklHeld(credential: string): Promise<Set<string>> {
  const { mirrorRows } = require('./trackerMirror');
  const rows: Array<{ key: string; data: any }> = await mirrorRows('simkl', credential);
  const out = new Set<string>();
  for (const { key, data } of rows) {
    const media = data?.movie ?? data?.show;
    const ids = Object.entries(media?.ids ?? {}).filter(([name, value]) => SIMKL_KEYS.includes(name) && value);
    if (key.startsWith('movies:') || data?.anime_type === 'movie') {
      for (const [name, value] of ids) out.add(`movie:${name}:${value}`);
      continue;
    }
    const mapped = Array.isArray(data?.mapped_tvdb_seasons) ? data.mapped_tvdb_seasons.map(Number) : [];
    const ownNumbers = key.startsWith('anime:') && mapped.length && !mapped.includes(1)
      ? ids.filter(([name]) => !['imdb', 'tmdb', 'tvdb'].includes(name))
      : ids;
    for (const season of Array.isArray(data?.seasons) ? data.seasons : []) {
      for (const episode of Array.isArray(season?.episodes) ? season.episodes : []) {
        for (const [name, value] of ownNumbers) out.add(`${name}:${value}:${season.number}:${episode.number}`);
        if (episode?.tvdb?.season != null && media?.ids?.tvdb) out.add(`tvdb:${media.ids.tvdb}:${episode.tvdb.season}:${episode.tvdb.episode}`);
        if (episode?.tvdb?.season != null && media?.ids?.imdb) out.add(`imdb:${media.ids.imdb}:${episode.tvdb.season}:${episode.tvdb.episode}`);
      }
    }
  }
  return out;
}

async function mdblistTmdbSpellings(credential: string): Promise<Map<string, string>> {
  const { mirrorRows } = require('./trackerMirror');
  const rows: Array<{ key: string; data: any }> = await mirrorRows('mdblist', credential);
  const out = new Map<string, string>();
  for (const { key, data } of rows) {
    if (!key.startsWith('ep:')) continue;
    const show = data?.episode?.show?.ids ?? {};
    const season = Number(data?.episode?.season);
    const number = Number(data?.episode?.number);
    if (!show.tmdb || !Number.isFinite(season) || !Number.isFinite(number)) continue;
    const tmdb = `tmdb:${show.tmdb}:${season}:${number}`;
    const named = data?.episode?.tvdb_ids;
    if (named?.series) {
      out.set(`tvdb:${named.series}:${named.season}:${named.episode}`, tmdb);
      if (show.imdb) out.set(`${show.imdb}:${named.season}:${named.episode}`, tmdb);
    } else if (show.imdb) {
      out.set(`${show.imdb}:${season}:${number}`, tmdb);
    }
  }
  return out;
}

function simklTargetKeys(target: Target, kind: 'movie' | 'episode'): string[] {
  const keys: string[] = [];
  for (const one of [target, target.fallback].filter(Boolean) as Array<{ ids: Record<string, any>; season?: number; episode?: number }>) {
    for (const [name, value] of Object.entries(one.ids)) {
      if (!SIMKL_KEYS.includes(name) || !value) continue;
      keys.push(kind === 'movie' ? `movie:${name}:${value}` : `${name}:${value}:${one.season ?? 1}:${one.episode}`);
    }
  }
  return keys;
}

function targetKeys(target: Target, kind: 'movie' | 'episode'): string[] {
  if (target.episodeIds) return [`tvdb:${target.ids.tvdb}:${target.season}:${target.episode}`];
  const keys: string[] = [];
  if (target.ids.tmdb) keys.push(nativeKey(kind, Number(target.ids.tmdb), target.season ?? 1, target.episode ?? null));
  if (target.ids.imdb) keys.push(kind === 'movie' ? `imdb:${target.ids.imdb}` : `imdb:${target.ids.imdb}:${target.season ?? 1}:${target.episode}`);
  return keys;
}

export interface MarkCopyPlan {
  items: MarkItem[];
  excluded: number;
  reasons: Record<string, number>;
  checkedAt: number;
}

const planMs = () => envInt('JELLYFIN_COPY_PLAN_MINUTES', 10, 1) * 60 * 1000;
// A plan is reused only while fresh, so it is not kept past that either.
const plans = new LRUCache<string, CopyPlan | MarkCopyPlan>({ max: 200, ttl: planMs(), ttlAutopurge: true });
const planKey = (userUUID: string, from: CopySide, to: CopySide, since: number, what: CopyWhat = 'watches', retry = false) => `${userUUID}|${from.key}|${to.key}|${since}|${what}|${retry}`;
const fresh = (plan: { checkedAt: number } | undefined) => plan && Date.now() - plan.checkedAt < planMs();

async function readFresh(side: CopySide): Promise<void> {
  const { syncMirror } = require('./trackerMirror');
  await syncMirror(side.service, side.credential, side.scoped);
}

export async function planMarkCopy(userUUID: string, what: Mark, from: CopySide, to: CopySide, since: number, again = false, retry = false): Promise<MarkCopyPlan> {
  const key = planKey(userUUID, from, to, since, what, retry);
  const held = plans.get(key) as MarkCopyPlan | undefined;
  if (held && !again && fresh(held)) return held;
  await readFresh(from);
  await readFresh(to);
  const planned = await planMarks(what, from, to, since);
  const tried = await triedBefore(userUUID, from, to, what, retry);
  const refused = planned.items.filter((item) => tried.has(copyKey(item))).length;
  const plan: MarkCopyPlan = {
    items: planned.items.filter((item) => !tried.has(copyKey(item))),
    excluded: planned.excluded + refused,
    reasons: refused ? { ...planned.reasons, refused } : planned.reasons,
    checkedAt: Date.now(),
  };
  plans.set(key, plan, { ttl: planMs() });
  return plan;
}

export async function planCopy(userUUID: string, from: CopySide, to: CopySide, since: number, again = false, retry = false): Promise<CopyPlan> {
  const key = planKey(userUUID, from, to, since, 'watches', retry);
  const held = plans.get(key) as CopyPlan | undefined;
  if (held && !again && fresh(held)) return held;
  await readFresh(from);
  await readFresh(to);
  const { indexedSnapshot, watchedAmong, movieSpellings } = require('./watched');
  if (TMDB_NUMBERED.has(from.service) && TMDB_NUMBERED.has(to.service)) {
    const target = await indexedSnapshot(to.service, to.credential, to.scoped);
    const entries = (await nativeEntries(from.service, from.credential, from.scoped)).filter((item) => !since || (item.at ?? 0) >= since);
    const held = await nativeHeld(to.service, to.credential);
    const present = new Set<string>();
    const all = [...new Set(entries.flatMap((item) => item.ids))];
    for (let at = 0; at < all.length; at += 2000) {
      for (const id of (await watchedAmong(target, all.slice(at, at + 2000))).keys()) present.add(id);
    }
    const { pendingWatches } = require('../trackerOutbox');
    const waiting = new Set<string>((await pendingWatches(to.service, to.credential).catch(() => [])).filter((p: any) => p.played).map((p: any) => String(p.videoId)));
    const tried = await triedBefore(userUUID, from, to, 'watches', retry);
    const left = entries.filter((item) => !held.has(nativeKey(item.kind, item.native!.tmdb, item.native!.season, item.native!.episode)) && !item.ids.some((id) => present.has(id) || waiting.has(id)));
    const plan: CopyPlan = {
      items: left.filter((item) => !tried.has(copyKey(item))),
      excluded: 0,
      blocked: { noId: 0, refused: left.filter((item) => tried.has(copyKey(item))).length },
      checkedAt: Date.now(),
    };
    plans.set(key, plan, { ttl: planMs() });
    return plan;
  }
  await indexedSnapshot(from.service, from.credential, from.scoped);
  const target = await indexedSnapshot(to.service, to.credential, to.scoped);
  const rows: any[] = await database.watchIndexSince(from.key, since);
  const viewings: Viewing[] = [];
  let excluded = 0;
  for (const row of rows) {
    const ids = [String(row.video_id), ...(await videoIdAliases(String(row.video_id)).catch(() => [] as string[]))];
    if (row.kind === 'movie') ids.push(...(await movieSpellings(String(row.video_id), from.scoped)));
    const viewing = viewingOf('', Number(row.at) || 0, [...new Set(ids)]);
    if (!viewing) continue;
    const listed = asListed(to.service, viewing);
    if (!belongsOn(to.service, listed, to.scoped)) {
      excluded += 1;
      continue;
    }
    viewings.push(listed);
  }
  const { pendingWatches } = require('../trackerOutbox');
  const waiting = new Set<string>((await pendingWatches(to.service, to.credential).catch(() => [])).filter((p: any) => p.played).map((p: any) => String(p.videoId)));
  const present = new Set<string>();
  const all = [...new Set(viewings.flatMap((v) => v.ids))];
  for (let at = 0; at < all.length; at += 2000) {
    for (const id of (await watchedAmong(target, all.slice(at, at + 2000))).keys()) present.add(id);
  }
  let missing = viewings.filter((v) => !v.ids.some((id) => present.has(id) || waiting.has(id)));
  const blocked = { noId: 0, refused: 0 };
  if (!ANIME_LISTS.has(to.service)) {
    const { mapWithConcurrency } = require('../../utils/concurrency');
    const held = TMDB_NUMBERED.has(to.service) ? await nativeHeld(to.service, to.credential) : to.service === 'simkl' ? await simklHeld(to.credential) : null;
    const keysOf = to.service === 'simkl' ? simklTargetKeys : targetKeys;
    const ownTmdb = to.service === 'simkl' && from.service === 'mdblist' ? await mdblistTmdbSpellings(from.credential) : null;
    const heldAsSpelled = (v: Viewing) => to.service === 'simkl' && held !== null && v.ids.some((id) => held.has(id) || held.has(ownTmdb?.get(id) ?? ''));
    const tried = await triedBefore(userUUID, from, to, 'watches', retry);
    const asItem = (v: Viewing): CopyItem => ({ ids: v.ids, kind: v.kind, metaId: v.metaId, season: v.season, episode: v.episode, at: v.at > 0 ? v.at : null });
    const unsent: Set<string> = await require('./trackerMatch').unsentAmong(userUUID, to.service, [...new Set(missing.flatMap((v) => v.ids))]).catch(() => new Set<string>());
    if (unsent.size) missing = missing.filter((v) => !v.ids.some((id) => unsent.has(id)));
    const targets: Array<Target | null> = await mapWithConcurrency(missing, envInt('JELLYFIN_COPY_PLAN_CONCURRENCY', 8, 1), (v: Viewing) => copyTarget(to.service, asItem(v), to.scoped).catch(() => null));
    missing = missing.filter((v, index) => {
      const target = targets[index];
      if (heldAsSpelled(v)) return false;
      if (!target) {
        blocked.noId += 1;
        return false;
      }
      if (held && keysOf(target, v.kind).some((key) => held.has(key))) return false;
      if (tried.has(copyKey(v))) {
        blocked.refused += 1;
        return false;
      }
      return true;
    });
  }
  if (ANIME_LISTS.has(to.service)) {
    const furthest = new Map<string, Viewing>();
    for (const v of missing) {
      const was = furthest.get(v.metaId);
      if (!was || (v.episode ?? 0) > (was.episode ?? 0)) furthest.set(v.metaId, v);
    }
    missing = [...furthest.values()];
  }
  const plan: CopyPlan = {
    items: missing.map((v) => ({ ids: v.ids, kind: v.kind, metaId: v.metaId, season: v.season, episode: v.episode, at: v.at > 0 ? v.at : null })),
    excluded,
    blocked,
    checkedAt: Date.now(),
  };
  plans.set(key, plan, { ttl: planMs() });
  return plan;
}

export async function startCopy(userUUID: string, profile: string, from: CopySide, to: CopySide, since: number, titles: string[] | null, what: CopyWhat = 'watches', retry = false): Promise<number> {
  const plan = what === 'watches' ? await planCopy(userUUID, from, to, since, true, retry) : await planMarkCopy(userUUID, what, from, to, since, true, retry);
  const all: Array<{ metaId: string }> = plan.items;
  const items = titles ? all.filter((item) => titles.includes(item.metaId)) : all;
  const id = await database.createCopyJob({ userUUID, profile, fromKey: from.key, fromService: from.service, toKey: to.key, toService: to.service, what, items });
  plans.delete(planKey(userUUID, from, to, since, what, retry));
  wakeCopies();
  return id;
}

export async function controlCopy(userUUID: string, id: number, action: 'pause' | 'resume' | 'stop'): Promise<boolean> {
  const job = await database.getCopyJob(id);
  if (!job || job.user_uuid !== userUUID) return false;
  const moved = action === 'stop'
    ? (job.status === 'running' || job.status === 'paused') && await database.updateCopyJob(id, { status: 'stopped', finishedAt: Date.now() }, job.status)
    : action === 'pause'
      ? job.status === 'running' && await database.updateCopyJob(id, { status: 'paused' }, 'running')
      : job.status === 'paused' && await database.updateCopyJob(id, { status: 'running', nextAt: 0 }, 'paused');
  if (!moved) return false;
  wakeCopies();
  return true;
}

type Outcome = { done: number; sent: number; failed: number; skipped?: number; wait?: number; error?: string; lost?: number[]; stalled?: boolean };

const sharesId = (a: Record<string, any> = {}, b: Record<string, any> = {}): boolean =>
  Object.entries(a).some(([key, value]) => value != null && b[key] != null && String(b[key]) === String(value));

function mdblistMissed(write: any, missed: any): boolean {
  const list = (key: string): any[] => (Array.isArray(missed?.[key]) ? missed[key] : []);
  if (write.season == null || write.episode == null) return list('movies').some((entry) => sharesId(entry?.ids, write.ids));
  if (list('shows').some((entry) => sharesId(entry?.ids, write.ids))) return true;
  return list('episodes').some((entry) => Number(entry?.season) === Number(write.season) && Number(entry?.number) === Number(write.episode) && sharesId(entry?.show?.ids, write.ids));
}

type Target = { ids: Record<string, any>; season?: number; episode?: number; episodeIds?: Record<string, number>; fallback?: { ids: Record<string, any>; season: number; episode: number } | null };

export async function copyTarget(service: string, item: CopyItem, config: any): Promise<Target | null> {
  if (item.native && TMDB_NUMBERED.has(service)) {
    const ids: Record<string, any> = { tmdb: item.native.tmdb, ...(item.native.imdb ? { imdb: item.native.imdb } : {}) };
    return item.kind === 'movie' ? { ids } : { ids, season: item.native.season ?? undefined, episode: item.native.episode ?? undefined };
  }
  const { parseMediaId, historyTarget } = require('../subtitleHandler');
  let target: Target | null = null;
  for (const spelling of spellingsFor(service, item.ids)) {
    const parsed = parseMediaId(spelling);
    target = parsed ? await historyTarget(parsed, config, service).catch(() => null) : null;
    if (target) break;
  }
  if (!target) return null;
  if (service === 'mdblist' && target.episodeIds) return target;
  if (TMDB_NUMBERED.has(service)) {
    const { tmdbIdFrom } = require('../../utils/publicmetadbUtils');
    const tmdb = target.ids.tmdb ?? await tmdbIdFrom(target.ids, item.kind === 'movie' ? 'movie' : 'series').catch(() => null);
    if (!tmdb) return null;
    target.ids = { ...target.ids, tmdb };
  }
  return target;
}

const strikes = new Map<number, number>();
const busy = new Set<number>();
let timer: NodeJS.Timeout | null = null;

const batchSize = (service: string): number => service === 'publicmetadb' || ANIME_LISTS.has(service) ? 10 : envInt('JELLYFIN_COPY_BATCH_SIZE', 100, 1);
const iso = (at: number | null) => (at ? new Date(at).toISOString() : null);

function statusOf(calls: Array<{ status: number }>, error: any): number {
  const last = calls[calls.length - 1];
  if (last) return last.status;
  return error ? -1 : 0;
}

export async function writeMdblist(items: CopyItem[], apiKey: string, config: any): Promise<Outcome> {
  const { mdblistCallsLeft, addHistoryBatch } = require('../../utils/mdbList');
  const { remaining, limit, resetAt } = mdblistCallsLeft(apiKey);
  if (remaining !== null && remaining <= Math.max(50, (limit ?? 0) / 5)) return { done: 0, sent: 0, failed: 0, wait: resetAt - Date.now(), error: 'Waiting for the MDBList quota to reset' };
  const writes: any[] = [];
  const from: number[] = [];
  const lost: number[] = [];
  for (const [i, item] of items.entries()) {
    const target = await copyTarget('mdblist', item, config);
    if (!target) lost.push(i);
    else {
      writes.push({ ...target, watchedAt: iso(item.at) });
      from.push(i);
    }
  }
  if (!writes.length) return { done: items.length, sent: 0, failed: lost.length, lost };
  const unresolved = lost.length;
  try {
    const { missed } = await addHistoryBatch(writes, apiKey);
    for (const [w, write] of writes.entries()) if (mdblistMissed(write, missed)) lost.push(from[w]);
    // A show MDBList did not find is one entry for every episode written under it.
    return { done: items.length, sent: writes.length - (lost.length - unresolved), failed: lost.length, lost };
  } catch (error: any) {
    if (error?.code === 'MDBLIST_QUOTA_EXHAUSTED' || error?.response?.status === 429) return { done: 0, sent: 0, failed: 0, wait: mdblistCallsLeft(apiKey).resetAt - Date.now(), error: 'MDBList quota spent' };
    throw error;
  }
}

export async function writeSimkl(items: CopyItem[], tokenId: string, config: any, rewatch = false): Promise<Outcome> {
  const { getSimklToken, getSimklQuota, addHistoryBatch } = require('../../utils/simklUtils');
  const accessToken = (await getSimklToken(tokenId))?.access_token;
  if (!accessToken) throw new Error('No Simkl token');
  const quota = await getSimklQuota(accessToken).catch(() => null);
  if (quota && quota.remaining <= Math.max(25, quota.limit / 5)) return { done: 0, sent: 0, failed: 0, wait: quota.resetsAt - Date.now(), error: 'Waiting for the Simkl allowance to reset' };
  const writes: any[] = [];
  const from: number[] = [];
  const lost: number[] = [];
  for (const [i, item] of items.entries()) {
    const target = await copyTarget('simkl', item, config);
    if (!target) lost.push(i);
    else {
      writes.push({ ...target, watchedAt: iso(item.at) });
      from.push(i);
    }
  }
  const failed = lost.length;
  if (writes.length) {
    try {
      const first = await addHistoryBatch(writes.map(({ fallback, ...write }) => write), accessToken, rewatch);
      const missed = new Set(first.missed.map((ids) => JSON.stringify(ids)));
      const firstMissed = (write: any) => missed.has(JSON.stringify(write.ids)) || first.missed.some((ids) => sharesId(ids, write.ids));
      const retry = writes.filter((write) => write.fallback && missed.has(JSON.stringify(write.ids)));
      if (!retry.length) {
        for (const [w, write] of writes.entries()) if (firstMissed(write)) lost.push(from[w]);
        return { done: items.length, sent: writes.length - first.notFound, failed: failed + first.notFound, lost };
      }
      const second = await addHistoryBatch(retry.map((write) => ({ ...write.fallback, watchedAt: write.watchedAt })), accessToken, rewatch);
      const recovered = retry.length - second.notFound;
      for (const [w, write] of writes.entries()) {
        if (firstMissed(write) && (!write.fallback || second.missed.some((ids) => sharesId(ids, write.fallback.ids)))) lost.push(from[w]);
      }
      return { done: items.length, sent: writes.length - first.notFound + recovered, failed: failed + first.notFound - recovered, lost };
    } catch (error: any) {
      const code = error?.response?.data?.error;
      if (error?.code === 'SIMKL_QUOTA_EXHAUSTED' || code === 'user_limit_exceeded' || code === 'app_limit_exceeded') {
        const later = await getSimklQuota(accessToken).catch(() => null);
        return { done: 0, sent: 0, failed: 0, wait: (later?.resetsAt ?? Date.now() + 6 * 60 * 60 * 1000) - Date.now(), error: 'Simkl allowance spent' };
      }
      if (code === 'rate_limit') return { done: 0, sent: 0, failed: 0, wait: 10_000, error: 'Simkl is finishing another write' };
      throw error;
    }
  }
  return { done: items.length, sent: 0, failed, lost };
}

async function writeOneByOne(service: string, items: CopyItem[], credential: string, config: any, userUUID: string): Promise<Outcome> {
  const { recordingTrackerCalls } = require('../../utils/trackerCalls');
  const gap = Math.ceil(1000 / envInt('JELLYFIN_COPY_PMDB_PER_SECOND', 4, 1));
  let done = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of items) {
    let existing = false;
    const { calls, error } = await recordingTrackerCalls(async () => {
      if (service === 'publicmetadb') {
        const { markWatched } = require('../../utils/publicmetadbUtils');
        const target = await copyTarget(service, item, config);
        if (!target) return;
        const answer = await markWatched(credential, target.ids.tmdb, item.kind === 'movie' ? 'movie' : 'tv', target.season, target.episode, iso(item.at));
        const created = Date.parse(String(answer?.item?.created ?? '').replace(' ', 'T'));
        existing = Number.isFinite(created) && Date.now() - created > 60_000;
      } else {
        await require('../playbackHandler').deliverCatchUp(service, { type: item.kind === 'movie' ? 'movie' : 'series', id: spellingFor(service, item.ids), at: item.at ?? Date.now() }, trackerConfig(config, service as AccountService), userUUID);
      }
    });
    if (!calls.length) {
      done += 1;
      failed += 1;
      continue;
    }
    const status = statusOf(calls, error);
    if (status === 0 || status === 429 || status >= 500 || (status === 403 && /disabled/i.test(String(calls[calls.length - 1]?.body ?? '')))) {
      return { done, sent, failed, skipped, wait: status === 429 ? 30_000 : 60_000, error: `${NAMES[service]} answered ${status || 'nothing'}`, stalled: status === 0 || status >= 500 };
    }
    done += 1;
    if (status >= 200 && status < 300 && existing) skipped += 1;
    else if (status >= 200 && status < 300) sent += 1;
    else failed += 1;
    await new Promise((resolve) => setTimeout(resolve, ANIME_LISTS.has(service) ? 1000 : gap));
  }
  return { done, sent, failed, skipped };
}

async function bringHome(userUUID: string, job: any, items: CopyItem[], config: any): Promise<void> {
  const fromCredential = credentialFor(config, job.from_service);
  if (!fromCredential) return;
  const dated = items.filter((item) => item.at);
  if (!dated.length) return;
  const held = new Set((await database.listWatchesFor(userUUID, job.profile, dated.flatMap((item) => item.ids))).map((row: any) => String(row.video_id)));
  const missing = dated.filter((item) => !item.ids.some((id) => held.has(id)));
  if (!missing.length) return;
  await pullDrift(userUUID, { service: job.from_service, credential: fromCredential, keys: new Set([job.profile]), scoped: config }, missing.map((item) => ({ profile: job.profile, at: item.at!, ids: item.ids, kind: item.kind, metaId: item.metaId, season: item.season, episode: item.episode })));
}

async function bringRatingsHome(userUUID: string, profile: string, items: MarkItem[]): Promise<void> {
  for (const item of items) {
    if ((item.kind !== 'movie' && item.kind !== 'series') || item.later || !item.rating) continue;
    const { imdb, tvdb, tmdb, kitsu, mal } = item.ids;
    const keys = [imdb, tvdb && item.kind === 'series' ? `tvdb:${tvdb}` : null, tmdb ? `tmdb:${tmdb}` : null, kitsu ? `kitsu:${kitsu}` : null, mal ? `mal:${mal}` : null].filter(Boolean) as string[];
    if (!keys.length) continue;
    const held: any[] = await database.listRatings(userUUID, profile, keys).catch(() => []);
    if (held.length) continue;
    await database.setRating(userUUID, profile, keys, Math.min(10, Math.max(1, Math.round(item.rating))), item.kind === 'movie' ? 'movie' : 'series');
  }
}

async function step(id: number): Promise<void> {
  const job = await database.getCopyJob(id);
  if (!job || job.status !== 'running') return;
  const stored = await database.getUserConfig(job.user_uuid).catch(() => null);
  const config = stored ? { ...scopeConfigToProfile(stored, job.user_uuid, job.profile || null), userUUID: job.user_uuid } : null;
  const credential = config ? credentialFor(config, job.to_service) : undefined;
  const { sourceKeyFor } = require('./trackerMirror');
  if (!credential || sourceKeyFor(job.to_service, credential) !== job.to_key) {
    await database.updateCopyJob(id, { status: 'failed', lastError: `${NAMES[job.to_service]} is no longer connected`, finishedAt: Date.now() }, 'running');
    return;
  }
  const what: CopyWhat = MARKS.has(job.what) ? job.what : 'watches';
  const items: any[] = job.items.slice(job.cursor, job.cursor + (what === 'watches' ? batchSize(job.to_service) : markBatchSize(what, job.to_service)));
  if (!items.length) {
    await finish(job);
    return;
  }
  let outcome: Outcome;
  try {
    if (what === 'ratings') await bringRatingsHome(job.user_uuid, job.profile, items);
    if (what !== 'watches') outcome = await writeMarks(what, items, { service: job.to_service, credential, scoped: config }, job.user_uuid);
    else {
      await bringHome(job.user_uuid, job, items, config);
      outcome = job.to_service === 'mdblist' ? await writeMdblist(items, credential, config)
        : job.to_service === 'simkl' ? await writeSimkl(items, credential, config)
        : await writeOneByOne(job.to_service, items, credential, config, job.user_uuid);
    }
    strikes.delete(id);
  } catch (error: any) {
    const count = (strikes.get(id) ?? 0) + 1;
    strikes.set(id, count);
    const message = String(error?.message || error).slice(0, 300);
    logger.warn(`Copy ${id} to ${job.to_service} stopped on a batch (${count}): ${message}`);
    if (count >= envInt('JELLYFIN_COPY_MAX_STRIKES', 5, 1)) {
      await database.updateCopyJob(id, { status: 'failed', lastError: message, finishedAt: Date.now() }, 'running');
      strikes.delete(id);
    } else {
      await database.updateCopyJob(id, { nextAt: Date.now() + count * 60_000, lastError: message });
    }
    return;
  }
  // A title the tracker keeps failing on is given up after a few tries, so it cannot hold the copy forever.
  let stalls = outcome.stalled ? (outcome.done ? 0 : Number(job.stalls) || 0) + 1 : 0;
  if (stalls >= ITEM_ATTEMPTS) {
    outcome.done += 1;
    outcome.failed += 1;
    stalls = 0;
  }
  const cursor = job.cursor + outcome.done;
  await database.updateCopyJob(id, {
    cursor,
    stalls,
    sent: job.sent + outcome.sent,
    failed: job.failed + outcome.failed,
    skipped: job.skipped + (outcome.skipped ?? 0),
    nextAt: Date.now() + Math.max(outcome.wait ?? 0, job.to_service === 'mdblist' ? 1000 : 0),
    lastError: outcome.error ?? null,
  });
  if (outcome.sent) {
    const { noteActivity } = require('../trackerActivity');
    const [one, many] = NOUNS[what];
    void noteActivity({
      sourceKey: job.to_key,
      service: job.to_service,
      kind: 'sent',
      userUUID: job.user_uuid,
      profile: job.profile,
      op: 'copy',
      video: what === 'watches' ? spellingFor(job.to_service, items[0].ids) : markVideo(items[0]),
      detail: { verb: `Copied ${outcome.sent} ${outcome.sent === 1 ? one : many} from ${NAMES[job.from_service]}`, count: outcome.sent },
    });
  }
  if (cursor >= job.total) await finish({ ...job, cursor });
}

async function finish(job: any): Promise<void> {
  // A stop or pause pressed while the last batch was out stays as it was.
  if (!(await database.updateCopyJob(job.id, { status: 'done', finishedAt: Date.now(), lastError: null }, 'running'))) return;
  const stored = await database.getUserConfig(job.user_uuid).catch(() => null);
  const config = stored ? { ...scopeConfigToProfile(stored, job.user_uuid, job.profile || null), userUUID: job.user_uuid } : null;
  const credential = config ? credentialFor(config, job.to_service) : undefined;
  if (!credential) return;
  await require('./watched').forgetTrackerReads(job.to_service, credential).catch(() => undefined);
  void require('./trackerMirror').syncMirror(job.to_service, credential, config).catch(() => undefined);
}

const CLAIM_MS = 10 * 60 * 1000;
const ITEM_ATTEMPTS = 6;

async function runClaimed(id: number): Promise<void> {
  if (!(await database.claimCopyJob(id, Date.now() + CLAIM_MS))) return;
  try {
    await step(id);
  } finally {
    await database.updateCopyJob(id, { claimedUntil: 0 }).catch(() => undefined);
  }
}

async function tick(): Promise<void> {
  const due: number[] = await database.dueCopyJobs(Date.now()).catch(() => []);
  for (const id of due) {
    if (busy.has(id)) continue;
    busy.add(id);
    void runClaimed(id).catch((error: any) => logger.warn(`Copy ${id} step failed: ${error?.message || error}`)).finally(() => busy.delete(id));
  }
}

export function wakeCopies(): void {
  void tick();
}

export function startTrackerCopy(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), envInt('JELLYFIN_COPY_TICK_SECONDS', 2, 1) * 1000);
  timer.unref?.();
}
