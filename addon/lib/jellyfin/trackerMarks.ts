import { MARK_KINDS, gapMs, trackerName, trackerOf, type Mark } from '../trackers';
import { TITLE_KEYS, keysOf, markKeys, type MarkItem, type MarkOutcome, type MarkSide, type MarkWrite } from '../trackers/marks';
import { credentialFor } from './trackerSource';

export type { Mark } from '../trackers';
export { markKeys, ratingKeys, type MarkItem, type MarkSide } from '../trackers/marks';
export const MARKS = new Set<string>(MARK_KINDS);

export interface MarkPlan {
  items: MarkItem[];
  excluded: number;
  reasons: Record<string, number>;
}

export async function readMarks(what: Mark, side: MarkSide): Promise<MarkItem[]> {
  const read = trackerOf(side.service)?.readMarks;
  return read ? read(what, side) : [];
}

async function heldOn(what: Mark, side: MarkSide): Promise<Set<string>> {
  const held = trackerOf(side.service)?.heldMarks;
  return held ? held(what, side) : keysOf(await readMarks(what, side));
}

function eligible(what: Mark, to: string, entry: MarkItem, config: any, context: unknown): string | null {
  const { shouldTrackServiceMediaType } = require('../watchTracking');
  if (!shouldTrackServiceMediaType(config, to, entry.kind === 'movie' ? 'movie' : 'series')) return 'turned off';
  if (what === 'dropped' && entry.kind !== 'series') return 'not a show';
  const refuse = trackerOf(to)?.refuseMark;
  if (refuse) return refuse(what, entry, context);
  return TITLE_KEYS.some((key) => entry.ids[key]) ? null : 'no id';
}

export async function planMarks(what: Mark, from: MarkSide, to: MarkSide, since: number): Promise<MarkPlan> {
  const tracker = trackerOf(to.service);
  const source = (await readMarks(what, from)).filter((entry) => !since || (entry.at ?? 0) >= since);
  const held = await heldOn(what, to);
  const context = tracker?.markContext ? await tracker.markContext(what, to) : null;
  const reasons: Record<string, number> = {};
  const taken = new Set<string>();
  const items: MarkItem[] = [];
  const ordered = [...source].sort((a, b) => Number(Boolean(a.later)) - Number(Boolean(b.later)) || (b.at ?? 0) - (a.at ?? 0));
  for (const raw of ordered) {
    const entry = tracker?.prepareMark ? tracker.prepareMark(raw) : raw;
    const keys = markKeys(entry);
    if (keys.some((key) => held.has(key) || taken.has(key))) continue;
    const why = eligible(what, to.service, entry, to.scoped, context);
    if (why) {
      reasons[why] = (reasons[why] ?? 0) + 1;
      continue;
    }
    keys.forEach((key) => taken.add(key));
    items.push(entry);
  }
  return { items, excluded: Object.values(reasons).reduce((sum, n) => sum + n, 0), reasons };
}

// A target that no longer takes the copy's sign-in would otherwise count every title as one it did not find.
export async function assertSignedIn(service: string, credential: string): Promise<void> {
  await trackerOf(service)?.checkSignIn?.(credential);
}

export const refusesSignIn = (status: number, body: unknown): boolean => status === 401 || (status === 403 && !/disabled/i.test(String(body ?? '')));

/** A refused sign-in stops the batch: before any title it fails the batch, after some it pauses on them. */
export function signInRefused(service: string, status: number, progress: { done: number; sent: number; failed: number; skipped: number }): MarkOutcome {
  const message = `${trackerName(service)} refused the sign-in (${status}); sign in again`;
  if (!progress.done) throw new Error(message);
  return { ...progress, wait: 60_000, error: message };
}

export async function writeMarks(what: Mark, items: MarkItem[], side: MarkSide, userUUID: string): Promise<MarkOutcome> {
  const tracker = trackerOf(side.service);
  if (tracker?.writeMarks) return tracker.writeMarks(what, items, side, userUUID);
  const writeMark = tracker?.writeMark;
  if (!writeMark) throw new Error(`${trackerName(side.service)} takes no ${what}`);
  await assertSignedIn(side.service, side.credential);
  const { recordingTrackerCalls } = require('../../utils/trackerCalls');
  const ratingGap = gapMs(side.service, 'ratings');
  const gap = gapMs(side.service);
  const onePerBatch = what === 'ratings' && Boolean(tracker.pace?.().ratingsPerHour);
  let done = 0;
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (const entry of items) {
    let landed: MarkWrite = 'failed';
    const { calls, error } = await recordingTrackerCalls(async () => { landed = await writeMark(what, entry, side, userUUID); });
    const last = calls[calls.length - 1];
    const status = last ? last.status : error ? -1 : 0;
    if (calls.length && (status === 0 || status === 429 || status >= 500)) {
      return { done, sent, failed, wait: status === 429 ? (what === 'ratings' ? 15 * 60_000 : 30_000) : 60_000, error: `${trackerName(side.service)} answered ${status || 'nothing'}`, stalled: status !== 429 };
    }
    if (calls.length && refusesSignIn(status, last?.body)) return signInRefused(side.service, status, { done, sent, failed, skipped });
    done += 1;
    const outcome: string = error ? 'failed' : landed;
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'skipped') skipped += 1;
    else failed += 1;
    if (onePerBatch) return { done, sent, failed, skipped, wait: outcome === 'sent' ? ratingGap : gap };
    await new Promise((resolve) => setTimeout(resolve, gap));
  }
  return { done, sent, failed, skipped };
}

export function markSide(service: string, config: any): MarkSide | null {
  const credential = credentialFor(config, service as any);
  return credential ? { service, credential, scoped: config } : null;
}

export function markVideo(entry: Pick<MarkItem, 'kind' | 'ids' | 'season' | 'episode'>): string {
  const { ids } = entry;
  if (entry.kind === 'movie') return ids.imdb ?? (ids.kitsu ? `kitsu:${ids.kitsu}` : ids.mal ? `mal:${ids.mal}` : `tmdb:${ids.tmdb}`);
  const base = ids.imdb ?? (ids.kitsu ? `kitsu:${ids.kitsu}` : ids.mal ? `mal:${ids.mal}` : ids.tvdb ? `tvdb:${ids.tvdb}` : `tmdb:${ids.tmdb}`);
  return `${base}:${entry.season ?? 1}:${entry.episode ?? 1}`;
}
