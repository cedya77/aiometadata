import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { videoIdAliases } from './aliases';
import { scopeConfigToProfile } from './profiles';
import { credentialFor, type Capable } from './trackerSource';
import { asListed, belongsOn, pullDrift, spellingFor, spellingsFor, viewingOf, type Viewing } from './trackerDrift';

const logger = consola.withTag('Trackers');
const database: any = require('../database');

const ANIME_LISTS = new Set<string>(['anilist', 'mal']);
export const COPY_SOURCES = new Set<string>(['simkl', 'mdblist', 'publicmetadb']);
const NAMES: Record<string, string> = { simkl: 'Simkl', mdblist: 'MDBList', publicmetadb: 'PublicMetaDB', anilist: 'AniList', mal: 'MyAnimeList' };

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
    if (service === 'publicmetadb' && key.startsWith('play:')) out.add(data?.media_type === 'movie' ? nativeKey('movie', Number(data?.tmdb_id), null, null) : nativeKey('episode', Number(data?.tmdb_id), Number(data?.season), Number(data?.episode)));
  }
  return out;
}

export interface CopyPlan {
  items: CopyItem[];
  excluded: number;
  checkedAt: number;
}

const plans = new Map<string, CopyPlan>();
const planKey = (userUUID: string, from: CopySide, to: CopySide, since: number) => `${userUUID}|${from.key}|${to.key}|${since}`;

async function readFresh(side: CopySide): Promise<void> {
  const { syncMirror } = require('./trackerMirror');
  await syncMirror(side.service, side.credential, side.scoped);
}

export async function planCopy(userUUID: string, from: CopySide, to: CopySide, since: number, fresh = false): Promise<CopyPlan> {
  const key = planKey(userUUID, from, to, since);
  const held = plans.get(key);
  if (held && !fresh && Date.now() - held.checkedAt < envInt('JELLYFIN_COPY_PLAN_MINUTES', 10, 1) * 60 * 1000) return held;
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
    const plan: CopyPlan = {
      items: entries.filter((item) => !held.has(nativeKey(item.kind, item.native!.tmdb, item.native!.season, item.native!.episode)) && !item.ids.some((id) => present.has(id) || waiting.has(id))),
      excluded: 0,
      checkedAt: Date.now(),
    };
    plans.set(key, plan);
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
    checkedAt: Date.now(),
  };
  plans.set(key, plan);
  return plan;
}

export async function startCopy(userUUID: string, profile: string, from: CopySide, to: CopySide, since: number, titles: string[] | null): Promise<number> {
  const plan = await planCopy(userUUID, from, to, since, true);
  const items = titles ? plan.items.filter((item) => titles.includes(item.metaId)) : plan.items;
  const id = await database.createCopyJob({ userUUID, profile, fromKey: from.key, fromService: from.service, toKey: to.key, toService: to.service, items });
  plans.delete(planKey(userUUID, from, to, since));
  wakeCopies();
  return id;
}

export async function controlCopy(userUUID: string, id: number, action: 'pause' | 'resume' | 'stop'): Promise<boolean> {
  const job = await database.getCopyJob(id);
  if (!job || job.user_uuid !== userUUID) return false;
  if (action === 'stop' && ['running', 'paused'].includes(job.status)) await database.updateCopyJob(id, { status: 'stopped', finishedAt: Date.now() });
  else if (action === 'pause' && job.status === 'running') await database.updateCopyJob(id, { status: 'paused' });
  else if (action === 'resume' && job.status === 'paused') await database.updateCopyJob(id, { status: 'running', nextAt: 0 });
  else return false;
  wakeCopies();
  return true;
}

type Outcome = { done: number; sent: number; failed: number; skipped?: number; wait?: number; error?: string };

type Target = { ids: Record<string, any>; season?: number; episode?: number; fallback?: { ids: Record<string, any>; season: number; episode: number } | null };

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

async function writeMdblist(items: CopyItem[], apiKey: string, config: any): Promise<Outcome> {
  const { mdblistCallsLeft, addHistoryBatch } = require('../../utils/mdbList');
  const { remaining, limit, resetAt } = mdblistCallsLeft(apiKey);
  if (remaining !== null && remaining <= Math.max(50, (limit ?? 0) / 5)) return { done: 0, sent: 0, failed: 0, wait: resetAt - Date.now(), error: 'Waiting for the MDBList quota to reset' };
  const writes: any[] = [];
  let unresolved = 0;
  for (const item of items) {
    const target = await copyTarget('mdblist', item, config);
    if (!target) unresolved += 1;
    else writes.push({ ...target, watchedAt: iso(item.at) });
  }
  if (!writes.length) return { done: items.length, sent: 0, failed: unresolved };
  try {
    const { notFound } = await addHistoryBatch(writes, apiKey);
    return { done: items.length, sent: writes.length - notFound, failed: unresolved + notFound };
  } catch (error: any) {
    if (error?.code === 'MDBLIST_QUOTA_EXHAUSTED' || error?.response?.status === 429) return { done: 0, sent: 0, failed: 0, wait: mdblistCallsLeft(apiKey).resetAt - Date.now(), error: 'MDBList quota spent' };
    throw error;
  }
}

async function writeSimkl(items: CopyItem[], tokenId: string, config: any): Promise<Outcome> {
  const { getSimklToken, getSimklQuota, addHistoryBatch } = require('../../utils/simklUtils');
  const accessToken = (await getSimklToken(tokenId))?.access_token;
  if (!accessToken) throw new Error('No Simkl token');
  const quota = await getSimklQuota(accessToken).catch(() => null);
  if (quota && quota.remaining <= Math.max(25, quota.limit / 5)) return { done: 0, sent: 0, failed: 0, wait: quota.resetsAt - Date.now(), error: 'Waiting for the Simkl allowance to reset' };
  const writes: any[] = [];
  let failed = 0;
  for (const item of items) {
    const target = await copyTarget('simkl', item, config);
    if (!target) failed += 1;
    else writes.push({ ...target, watchedAt: iso(item.at) });
  }
  if (writes.length) {
    try {
      const first = await addHistoryBatch(writes.map(({ fallback, ...write }) => write), accessToken);
      const missed = new Set(first.missed.map((ids) => JSON.stringify(ids)));
      const retry = writes.filter((write) => write.fallback && missed.has(JSON.stringify(write.ids)));
      if (!retry.length) return { done: items.length, sent: writes.length - first.notFound, failed: failed + first.notFound };
      const second = await addHistoryBatch(retry.map((write) => ({ ...write.fallback, watchedAt: write.watchedAt })), accessToken);
      const recovered = retry.length - second.notFound;
      return { done: items.length, sent: writes.length - first.notFound + recovered, failed: failed + first.notFound - recovered };
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
  return { done: items.length, sent: 0, failed };
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
        await require('../playbackHandler').deliverCatchUp(service, { type: item.kind === 'movie' ? 'movie' : 'series', id: spellingFor(service, item.ids), at: item.at ?? Date.now() }, config, userUUID);
      }
    });
    if (!calls.length) {
      done += 1;
      failed += 1;
      continue;
    }
    const status = statusOf(calls, error);
    if (status === 0 || status === 429 || status >= 500 || (status === 403 && /disabled/i.test(String(calls[calls.length - 1]?.body ?? '')))) {
      return { done, sent, failed, skipped, wait: status === 429 ? 30_000 : 60_000, error: `${NAMES[service]} answered ${status || 'nothing'}` };
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

async function step(id: number): Promise<void> {
  const job = await database.getCopyJob(id);
  if (!job || job.status !== 'running') return;
  const stored = await database.getUserConfig(job.user_uuid).catch(() => null);
  const config = stored ? scopeConfigToProfile(stored, job.user_uuid, job.profile || null) : null;
  const credential = config ? credentialFor(config, job.to_service) : undefined;
  const { sourceKeyFor } = require('./trackerMirror');
  if (!credential || sourceKeyFor(job.to_service, credential) !== job.to_key) {
    await database.updateCopyJob(id, { status: 'failed', lastError: `${NAMES[job.to_service]} is no longer connected`, finishedAt: Date.now() });
    return;
  }
  const items: CopyItem[] = job.items.slice(job.cursor, job.cursor + batchSize(job.to_service));
  if (!items.length) {
    await finish(job);
    return;
  }
  let outcome: Outcome;
  try {
    await bringHome(job.user_uuid, job, items, config);
    outcome = job.to_service === 'mdblist' ? await writeMdblist(items, credential, config)
      : job.to_service === 'simkl' ? await writeSimkl(items, credential, config)
      : await writeOneByOne(job.to_service, items, credential, config, job.user_uuid);
    strikes.delete(id);
  } catch (error: any) {
    const count = (strikes.get(id) ?? 0) + 1;
    strikes.set(id, count);
    const message = String(error?.message || error).slice(0, 300);
    logger.warn(`Copy ${id} to ${job.to_service} stopped on a batch (${count}): ${message}`);
    if (count >= envInt('JELLYFIN_COPY_MAX_STRIKES', 5, 1)) {
      await database.updateCopyJob(id, { status: 'failed', lastError: message, finishedAt: Date.now() });
      strikes.delete(id);
    } else {
      await database.updateCopyJob(id, { nextAt: Date.now() + count * 60_000, lastError: message });
    }
    return;
  }
  const cursor = job.cursor + outcome.done;
  await database.updateCopyJob(id, {
    cursor,
    sent: job.sent + outcome.sent,
    failed: job.failed + outcome.failed,
    skipped: job.skipped + (outcome.skipped ?? 0),
    nextAt: Date.now() + Math.max(outcome.wait ?? 0, job.to_service === 'mdblist' ? 1000 : 0),
    lastError: outcome.error ?? null,
  });
  if (outcome.sent) {
    const { noteActivity } = require('../trackerActivity');
    void noteActivity({
      sourceKey: job.to_key,
      service: job.to_service,
      kind: 'sent',
      userUUID: job.user_uuid,
      profile: job.profile,
      op: 'copy',
      video: spellingFor(job.to_service, items[0].ids),
      detail: { verb: `Copied ${outcome.sent} ${outcome.sent === 1 ? 'watch' : 'watches'} from ${NAMES[job.from_service]}`, count: outcome.sent },
    });
  }
  if (cursor >= job.total) await finish({ ...job, cursor });
}

async function finish(job: any): Promise<void> {
  await database.updateCopyJob(job.id, { status: 'done', finishedAt: Date.now(), lastError: null });
  const stored = await database.getUserConfig(job.user_uuid).catch(() => null);
  const config = stored ? scopeConfigToProfile(stored, job.user_uuid, job.profile || null) : null;
  const credential = config ? credentialFor(config, job.to_service) : undefined;
  if (!credential) return;
  await require('./watched').forgetTrackerReads(job.to_service, credential).catch(() => undefined);
  void require('./trackerMirror').syncMirror(job.to_service, credential, config).catch(() => undefined);
}

async function tick(): Promise<void> {
  const due: number[] = await database.dueCopyJobs(Date.now()).catch(() => []);
  for (const id of due) {
    if (busy.has(id)) continue;
    busy.add(id);
    void step(id).catch((error: any) => logger.warn(`Copy ${id} step failed: ${error?.message || error}`)).finally(() => busy.delete(id));
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
