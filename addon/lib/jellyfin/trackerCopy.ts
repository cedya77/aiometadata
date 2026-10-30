import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { trackerConfig, type AccountService } from '../accounts';
import { videoIdAliases } from './aliases';
import { listProfiles, scopeConfigToProfile } from './profiles';
import { credentialFor, type Capable } from './trackerSource';
import { asListed, belongsOn, furthestPerEntry, pullDrift, spellingFor, spellingsFor, viewingOf, type Viewing } from './trackerDrift';
import { MARKS, markVideo, planMarks, ratingKeys, writeMarks, type Mark, type MarkItem } from './trackerMarks';
import { copyBatch, gapMs, isAnimeList, trackerName, trackerOf } from '../trackers';
import { aliasesOf, copyTarget as targetOn, heldKeysOf, nativeKey, spellingsOf, type CopyItem, type CopyTarget, type MirrorRow, type WatchOutcome } from '../trackers/watches';

const logger = consola.withTag('Trackers');
const database: any = require('../database');

const NOUNS: Record<string, [string, string]> = { watches: ['watch', 'watches'], ratings: ['rating', 'ratings'], watchlist: ['watchlist title', 'watchlist titles'], dropped: ['dropped show', 'dropped shows'] };
export type CopyWhat = 'watches' | Mark;

export interface CopySide {
  service: Capable;
  credential: string;
  key: string;
  keys: Set<string>;
  scoped: any;
}

export type { CopyItem } from '../trackers/watches';

const tmdbNumbered = (service: string) => Boolean(trackerOf(service)?.tmdbWatches);

async function tmdbWatchesOf(service: string, credential: string) {
  const { mirrorRows } = require('./trackerMirror');
  const rows: MirrorRow[] = await mirrorRows(service, credential);
  return trackerOf(service)?.tmdbWatches?.(rows) ?? [];
}

async function nativeEntries(service: string, credential: string, config: any): Promise<CopyItem[]> {
  const { movieSpellings } = require('./watched');
  const byKey = new Map<string, CopyItem>();
  for (const watch of await tmdbWatchesOf(service, credential)) {
    const { kind, tmdb, imdb, season, episode, at } = watch;
    if (!Number.isFinite(tmdb) || tmdb <= 0) continue;
    const key = nativeKey(kind, tmdb, season, episode);
    const held = byKey.get(key);
    if (held) {
      if ((at ?? 0) > (held.at ?? 0)) held.at = at;
      continue;
    }
    const spellings = spellingsOf(watch);
    const ids = new Set(spellings);
    for (const spelling of spellings) for (const alias of await videoIdAliases(spelling).catch(() => [] as string[])) ids.add(alias);
    if (kind === 'movie') for (const spelling of spellings) for (const more of await movieSpellings(spelling, config)) ids.add(more);
    const list = [...ids];
    byKey.set(key, { ids: list, kind, metaId: kind === 'movie' ? list[0] : imdb ?? `tmdb:${tmdb}`, season, episode, at, native: { tmdb, imdb, season, episode } });
  }
  return [...byKey.values()];
}

async function nativeHeld(service: string, credential: string): Promise<Set<string>> {
  return new Set((await tmdbWatchesOf(service, credential)).flatMap(heldKeysOf));
}

async function tmdbAliases(service: string, credential: string): Promise<Map<string, string>> {
  return new Map((await tmdbWatchesOf(service, credential)).flatMap(aliasesOf));
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

function targetKeys(target: CopyTarget, kind: 'movie' | 'episode'): string[] {
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
  if (tmdbNumbered(from.service) && tmdbNumbered(to.service)) {
    const target = await indexedSnapshot(to.service, to.credential, to.scoped);
    const { shouldTrackServiceMediaType } = require('../watchTracking');
    const recent = (await nativeEntries(from.service, from.credential, from.scoped)).filter((item) => !since || (item.at ?? 0) >= since);
    // The target's own tracking settings hold here as on the general path.
    const entries = recent.filter((item) => shouldTrackServiceMediaType(to.scoped, to.service, item.kind === 'movie' ? 'movie' : 'series'));
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
      excluded: recent.length - entries.length,
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
  if (!isAnimeList(to.service)) {
    const { mapWithConcurrency } = require('../../utils/concurrency');
    const spelled = trackerOf(to.service)?.watchesHeld;
    const held = tmdbNumbered(to.service) ? await nativeHeld(to.service, to.credential) : spelled ? await spelled.read(to.credential) : null;
    const keysOf = spelled ? spelled.keys : targetKeys;
    const ownTmdb = spelled && tmdbNumbered(from.service) ? await tmdbAliases(from.service, from.credential) : null;
    const heldAsSpelled = (v: Viewing) => Boolean(spelled) && held !== null && v.ids.some((id) => held.has(id) || held.has(ownTmdb?.get(id) ?? ''));
    const tried = await triedBefore(userUUID, from, to, 'watches', retry);
    const asItem = (v: Viewing): CopyItem => ({ ids: v.ids, kind: v.kind, metaId: v.metaId, season: v.season, episode: v.episode, at: v.at > 0 ? v.at : null });
    const unsent: Set<string> = await require('./trackerMatch').unsentAmong(userUUID, to.service, [...new Set(missing.flatMap((v) => v.ids))]).catch(() => new Set<string>());
    if (unsent.size) missing = missing.filter((v) => !v.ids.some((id) => unsent.has(id)));
    const targets: Array<CopyTarget | null> = await mapWithConcurrency(missing, envInt('JELLYFIN_COPY_PLAN_CONCURRENCY', 8, 1), (v: Viewing) => copyTarget(to.service, asItem(v), to.scoped).catch(() => null));
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
  if (isAnimeList(to.service)) missing = furthestPerEntry(to.service, missing);
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

type Outcome = WatchOutcome;

export async function copyTarget(service: string, item: CopyItem, config: any): Promise<CopyTarget | null> {
  const tracker = trackerOf(service);
  return tracker ? targetOn(tracker, item, config) : null;
}

const strikes = new Map<number, number>();
const busy = new Set<number>();
let timer: NodeJS.Timeout | null = null;


function statusOf(calls: Array<{ status: number }>, error: any): number {
  const last = calls[calls.length - 1];
  if (last) return last.status;
  return error ? -1 : 0;
}

async function writeOneByOne(service: string, items: CopyItem[], credential: string, config: any, userUUID: string): Promise<Outcome> {
  const { recordingTrackerCalls } = require('../../utils/trackerCalls');
  const gap = gapMs(service);
  const { assertSignedIn, refusesSignIn, signInRefused } = require('./trackerMarks');
  await assertSignedIn(service, credential);
  let done = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of items) {
    let existing = false;
    const writeWatch = trackerOf(service)?.writeWatch;
    const { calls, error } = await recordingTrackerCalls(async () => {
      if (writeWatch) {
        existing = await writeWatch(item, credential, config);
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
      return { done, sent, failed, skipped, wait: status === 429 ? 30_000 : 60_000, error: `${trackerName(service)} answered ${status || 'nothing'}`, stalled: status === 0 || status >= 500 };
    }
    if (refusesSignIn(status, calls[calls.length - 1]?.body)) return signInRefused(service, status, { done, sent, failed, skipped });
    done += 1;
    if (status >= 200 && status < 300 && existing) skipped += 1;
    else if (status >= 200 && status < 300) sent += 1;
    else failed += 1;
    await new Promise((resolve) => setTimeout(resolve, gap));
  }
  return { done, sent, failed, skipped };
}

// A copy in the All view can start from another profile's tracker, so the source is found by the key it started with.
function sourceCredential(stored: any, job: any): string | undefined {
  const { sourceKeyFor } = require('./trackerMirror');
  for (const profile of listProfiles(stored, job.user_uuid)) {
    const credential = credentialFor({ ...scopeConfigToProfile(stored, job.user_uuid, profile.id || null), userUUID: job.user_uuid }, job.from_service);
    if (credential && sourceKeyFor(job.from_service, credential) === job.from_key) return credential;
  }
  return undefined;
}

async function bringHome(userUUID: string, job: any, items: CopyItem[], config: any, stored: any): Promise<void> {
  const fromCredential = sourceCredential(stored, job);
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
    const keys = ratingKeys(item);
    if (!keys.length) continue;
    const held: any[] = await database.listRatings(userUUID, profile, keys, item.kind === 'movie' ? 'movie' : 'series').catch(() => []);
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
    await database.updateCopyJob(id, { status: 'failed', lastError: `${trackerName(job.to_service)} is no longer connected`, finishedAt: Date.now() }, 'running');
    return;
  }
  const what: CopyWhat = MARKS.has(job.what) ? job.what : 'watches';
  const items: any[] = job.items.slice(job.cursor, job.cursor + copyBatch(job.to_service, what));
  if (!items.length) {
    await finish(job);
    return;
  }
  let outcome: Outcome;
  try {
    if (what === 'ratings') await bringRatingsHome(job.user_uuid, job.profile, items);
    if (what !== 'watches') outcome = await writeMarks(what, items, { service: job.to_service, credential, scoped: config }, job.user_uuid);
    else {
      await bringHome(job.user_uuid, job, items, config, stored);
      const batch = trackerOf(job.to_service)?.writeWatches;
      outcome = batch ? await batch.write(items, credential, config) : await writeOneByOne(job.to_service, items, credential, config, job.user_uuid);
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
    nextAt: Date.now() + Math.max(outcome.wait ?? 0, trackerOf(job.to_service)?.batchGapMs ?? 0),
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
      detail: { verb: `Copied ${outcome.sent} ${outcome.sent === 1 ? one : many} from ${trackerName(job.from_service)}`, count: outcome.sent },
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
