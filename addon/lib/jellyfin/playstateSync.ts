import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { sourceFor } from './trackerSource';
import { getPlaystatesAcross, upsertPlaystateEverywhere } from './aliases';
import { profileKey, scopeConfigToProfile } from './profiles';
import { accountOwner } from '../accounts';
import { runAsAccountOwner } from './viewer';

const logger = consola.withTag('Jellyfin');

const database: any = require('../database');
const { runWithRequestContext }: any = require('../logBuffer');

// Pulls tracker state into the playstate table. The table wins on anything it
// already holds; only titles it has never seen are taken from the tracker.
export async function syncPlaystateFor(userUUID: string, config: any): Promise<{ added: number; skipped: number; unchanged?: boolean }> {
  const { trackerSnapshot } = require('./resume');
  const { watchedSnapshot, allWatched } = require('./watched');

  let added = 0;
  let skipped = 0;
  const profile = profileKey(config);

  const resume = await trackerSnapshot(userUUID, config);
  const snapshot = await watchedSnapshot(userUUID, config, { patient: true });

  // A pass only takes in what the tracker says, and the table wins over anything it has
  // already seen, so a tracker unchanged since the last pass has nothing new to give.
  const { createHash } = require('crypto');
  const { readGlobalCache, writeGlobalCache } = require('../getCache');
  const digest = snapshot.fingerprint
    ? createHash('sha256').update(`${snapshot.fingerprint}|${resume.map((row: any) => `${row.videoId}:${row.progress}:${row.updatedAt}`).join(',')}`).digest('hex').substring(0, 16)
    : '';
  const passKey = `jellyfin_playstate_pass_v2:${userUUID}${profile ? `:${profile}` : ''}`;
  if (digest && (await readGlobalCache(passKey))?.digest === digest) return { added, skipped, unchanged: true };
  for (const row of resume) {
    // The most recent action wins: a point the tracker set after this row's last
    // change replaces it, whether the row is a point, a mark or a rewatch; an
    // older one is what the row already replaced.
    const existing = await database.getPlaystate(userUUID, row.videoId, profile);
    if (existing && !((row.updatedAt || 0) > Number(existing.updated_at))) {
      skipped += 1;
      continue;
    }
    if (row.progress <= 0) continue;

    // Simkl sends a percentage and no runtime, so the runtime comes from the meta.
    const runtimeMs = (row.runtimeMinutes ?? 0) * 60000 || (await runtimeFromMeta(userUUID, row));
    if (runtimeMs <= 0) continue;

    await upsertPlaystateEverywhere(userUUID, row.videoId, {
      positionMs: Math.round((runtimeMs * row.progress) / 100),
      runtimeMs,
      lastPlayedAt: row.updatedAt || null,
      origin: row.service ?? null,
    }, profile);
    added += 1;
  }

  // A row holding a resume point the tracker no longer has, on a title its
  // history lists as watched after that point, was finished elsewhere: the
  // tracker's last word on it is the watch. A watch older than the point, or
  // one the tracker cannot date, is the earlier viewing this row is a rewatch of.
  const origin = sourceFor(config);
  const paused = new Set(resume.map((row) => row.videoId));
  const watched = await allWatched(snapshot);
  const finished = [...watched.episodes, ...watched.movies];
  const known = await getPlaystatesAcross(userUUID, finished, profile);
  const logged = await database.watchedVideoIds(userUUID, profile);
  for (const videoId of finished) {
    const row = known.get(videoId);
    const trackerAt = watched.at.get(videoId);
    // An import written without a date takes the tracker's once it has one.
    if (row && row.played && !row.last_played_at && !Number(row.position_ms) && trackerAt) {
      await upsertPlaystateEverywhere(userUUID, videoId, { lastPlayedAt: trackerAt, origin, watch: { at: trackerAt, kind: 'dated' } }, profile);
      added += 1;
      continue;
    }
    const watchedAt = trackerAt ?? 0;
    if (row && row.played && Number(row.position_ms) > 0 && !paused.has(videoId) && watchedAt > Number(row.updated_at)) {
      const runtimeMs = Number(row.runtime_ms) || 0;
      const gapMs = runtimeMs > 0 ? runtimeMs / 2 : envInt('JELLYFIN_REWATCH_MIN_GAP_MINUTES', 10, 0) * 60_000;
      await upsertPlaystateEverywhere(userUUID, videoId, { positionMs: 0, played: true, lastPlayedAt: watchedAt, origin, watch: { at: watchedAt, kind: 'finish', gapMs } }, profile);
      added += 1;
      continue;
    }
    if (row && row.played && trackerAt && !logged.has(videoId) && !logged.has(String(row.video_id))) {
      for (const id of new Set([videoId, String(row.video_id)])) {
        await database.logWatch(userUUID, profile, id, { at: trackerAt, kind: 'dated' }, true, origin);
      }
      added += 1;
      continue;
    }
    if (row && (row.played || paused.has(videoId))) {
      skipped += 1;
      continue;
    }
    // An unplayed row, part-played or marked so here, keeps its state unless
    // the tracker dates the watch after it; an undated watch cannot outrank it.
    if (row && !((watched.at.get(videoId) ?? 0) > Number(row.updated_at))) {
      skipped += 1;
      continue;
    }
    const watch = trackerAt ? { watch: { at: trackerAt, kind: 'first' } } : {};
    await upsertPlaystateEverywhere(userUUID, videoId, row ? { positionMs: 0, played: true, origin, ...watch } : { positionMs: 0, played: true, lastPlayedAt: trackerAt ?? null, origin, ...watch }, profile);
    added += 1;
  }

  // Passed again at least this often, whatever the tracker says, in case a pass was cut short.
  if (digest) await writeGlobalCache(passKey, { digest }, envInt('JELLYFIN_PLAYSTATE_SYNC_RECHECK_HOURS', 24, 1) * 60 * 60);
  return { added, skipped };
}

export async function runtimeFromMeta(userUUID: string, row: any): Promise<number> {
  const { fetchMeta } = require('./items');
  const { parseStremioId } = require('./ids');
  try {
    const meta = await fetchMeta(userUUID, row.kind === 'movie' ? 'movie' : 'series', row.metaId);
    if (!meta) return 0;

    let runtime: any = meta.runtime;
    if (row.kind === 'episode') {
      const parsed = parseStremioId(row.videoId);
      const video = (meta.videos || []).find((v: any) => String(v.id) === row.videoId)
        || (parsed && (meta.videos || []).find((v: any) => v.season === parsed.season && v.episode === parsed.episode));
      runtime = video?.runtime || runtime;
    }

    const text = String(runtime || '');
    const hours = /(\d+)\s*h/.exec(text);
    const minutes = /(\d+)\s*min/.exec(text);
    const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
    return total > 0 ? total * 60000 : 0;
  } catch {
    return 0;
  }
}

export async function forgetImported(userUUID: string, profile: string): Promise<number> {
  const removed = await database.deleteImportedPlaystate(userUUID, profile);
  const { writeGlobalCache } = require('../getCache');
  await writeGlobalCache(`jellyfin_playstate_pass_v2:${userUUID}${profile ? `:${profile}` : ''}`, { digest: null }, 60);
  const { invalidateResume } = require('./resume');
  invalidateResume(userUUID);
  logger.info(`Forgot ${removed} imported playstate row(s) of ${userUUID}${profile ? ` (${profile})` : ''}`);
  return removed;
}

let running = false;
const lastSync = { startedAt: 0, finishedAt: 0, configurations: 0, added: 0, reached: 0, total: 0, timedOut: 0, complete: true };
// Where the last run stopped, so one cut short by its budget carries on from there.
let cursor = 0;
let followUp: NodeJS.Timeout | null = null;

const TIMED_OUT = Symbol('timed out');

export function syncStatus() {
  return { ...lastSync, running };
}

/** What the sync is doing, for a note beside an event loop stall. */
export function syncActivity(): string | null {
  return running ? `playstate sync running (${lastSync.reached} of ${lastSync.total} configurations reached)` : null;
}

function withinTime<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** One configuration and each user keeping its own history: tracker positions and watches, then Next Up. */
async function syncConfiguration(userUUID: string): Promise<{ added: number } | null> {
  let stored: any;
  try {
    stored = await database.getUserConfig(userUUID);
  } catch {
    return null;
  }
  if (!stored) return null;
  const cards = Array.isArray(stored.jellyfinUsers) ? stored.jellyfinUsers : [];
  const users = cards
    .filter((card: any) => typeof card?.id === 'string' && card.id)
    .map((card: any) => scopeConfigToProfile(stored, userUUID, card.id))
    .filter((config: any) => profileKey(config));
  const targets = [stored, ...users].filter((config: any) => sourceFor(config));
  if (!targets.length) return null;

  let added = 0;
  for (const config of targets) {
    const owner = accountOwner(config);
    const who = owner ? `${userUUID} (${owner})` : userUUID;
    await runAsAccountOwner(owner, async () => {
      try {
        added += (await runWithRequestContext(userUUID, () => syncPlaystateFor(userUUID, config))).added;
      } catch (error: any) {
        logger.debug(`Playstate sync failed for ${who}: ${error?.message || error}`);
      }
      // Keeps the Next Up episode index warm off the request path.
      try {
        const { warmNextUpIndex, queueUncountedSeries } = require('./episodeIndex');
        const built = await runWithRequestContext(userUUID, () => warmNextUpIndex(userUUID, config));
        if (built) logger.debug(`Episode index built for ${built} show(s) of ${who}`);
        const queued = await runWithRequestContext(userUUID, () => queueUncountedSeries(userUUID, config));
        if (queued) logger.debug(`Episode index queued for ${queued} show(s) of ${who}`);
      } catch (error: any) {
        logger.debug(`Episode index warm failed for ${who}: ${error?.message || error}`);
      }
    });
  }
  return { added };
}

/**
 * Configurations used lately, a few at a time, within a budget. What a run does not reach
 * goes first in the next, which comes a minute later rather than a whole interval; one
 * configuration whose tracker hangs gives up its place after a while.
 */
export async function syncAllPlaystate(): Promise<void> {
  if (running) return;
  running = true;
  const started = Date.now();
  const deadline = started + envInt('JELLYFIN_PLAYSTATE_SYNC_BUDGET', 600, 30) * 1000;
  const concurrency = envInt('JELLYFIN_PLAYSTATE_SYNC_CONCURRENCY', 3, 1);
  const perConfigurationMs = envInt('JELLYFIN_PLAYSTATE_SYNC_USER_TIMEOUT', 120, 10) * 1000;
  const activeHours = envInt('JELLYFIN_PLAYSTATE_SYNC_ACTIVE_HOURS', 48, 0);
  Object.assign(lastSync, { startedAt: started, reached: 0, total: 0, timedOut: 0 });

  try {
    const { seenConfigurations, seenConfigurationsSince } = require('./context');
    const seen: string[] | null = activeHours > 0
      ? await seenConfigurationsSince(started - activeHours * 60 * 60 * 1000)
      : await seenConfigurations();
    const uuids: string[] = seen ?? (await database.getAllUserUUIDs());
    const from = uuids.length ? cursor % uuids.length : 0;
    const order = [...uuids.slice(from), ...uuids.slice(0, from)];
    lastSync.total = order.length;

    let next = 0;
    let users = 0;
    let added = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, order.length) }, async () => {
        while (next < order.length && Date.now() < deadline) {
          const userUUID = order[next++];
          lastSync.reached = next;
          await new Promise((resolve) => setImmediate(resolve));
          const outcome = await withinTime(syncConfiguration(userUUID), perConfigurationMs);
          if (outcome === TIMED_OUT) {
            lastSync.timedOut += 1;
            logger.warn(`Playstate sync gave up waiting on ${userUUID} after ${Math.round(perConfigurationMs / 1000)}s`);
          } else if (outcome) {
            users += 1;
            added += outcome.added;
          }
        }
      })
    );

    const complete = next >= order.length;
    cursor = complete ? 0 : (from + next) % Math.max(1, uuids.length);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (!complete) {
      logger.info(`Playstate sync reached ${next} of ${order.length} configuration(s) in its ${seconds}s budget; the rest follow in a minute`);
      if (followUp) clearTimeout(followUp);
      followUp = setTimeout(() => {
        followUp = null;
        syncAllPlaystate().catch(() => undefined);
      }, 60 * 1000);
      followUp.unref?.();
    } else if (added) {
      logger.info(`Playstate sync: ${added} title(s) taken from trackers across ${users} configuration(s) in ${seconds}s`);
    }
    Object.assign(lastSync, { finishedAt: Date.now(), configurations: users, added, complete });
  } finally {
    running = false;
  }
}

export function startPlaystateSync(): void {
  const { registerStallActivity } = require('../eventLoopLag');
  registerStallActivity(syncActivity);
  const intervalMs = envInt('JELLYFIN_PLAYSTATE_SYNC_INTERVAL', 30 * 60, 60) * 1000;
  const initialDelayMs = envInt('JELLYFIN_PLAYSTATE_SYNC_DELAY', 2 * 60, 0) * 1000;

  setTimeout(() => {
    syncAllPlaystate().catch(() => undefined);
    setInterval(() => syncAllPlaystate().catch(() => undefined), intervalMs).unref?.();
  }, initialDelayMs).unref?.();
}
