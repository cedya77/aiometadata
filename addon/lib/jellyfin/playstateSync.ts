import consola from 'consola';
import { envInt } from '../../utils/envNumber';
import { sourceFor } from './trackerSource';
import { getPlaystatesAcross, upsertPlaystateEverywhere } from './aliases';

const logger = consola.withTag('Jellyfin');

const database: any = require('../database');

// Pulls tracker state into the playstate table. The table wins on anything it
// already holds; only titles it has never seen are taken from the tracker.
export async function syncPlaystateFor(userUUID: string, config: any): Promise<{ added: number; skipped: number }> {
  const { trackerSnapshot } = require('./resume');
  const { watchedSnapshot } = require('./watched');

  let added = 0;
  let skipped = 0;

  const resume = await trackerSnapshot(userUUID, config);
  for (const row of resume) {
    // A finished row with no position can still take one, a rewatch, but only
    // from activity newer than the row: an older point is what the mark replaced.
    const existing = await database.getPlaystate(userUUID, row.videoId);
    if (existing && (Number(existing.position_ms) > 0 || !existing.played || (row.updatedAt || 0) <= Number(existing.updated_at))) {
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
    });
    added += 1;
  }

  // A row holding a resume point the tracker no longer has, on a title its
  // history now lists as watched, was finished elsewhere: the tracker's last
  // word on it is the watch. A resume point it still holds is a rewatch.
  const paused = new Set(resume.map((row) => row.videoId));
  const watched = await watchedSnapshot(userUUID, config);
  const finished = [...watched.episodes, ...watched.movies];
  const known = await getPlaystatesAcross(userUUID, finished);
  for (const videoId of finished) {
    const row = known.get(videoId);
    if (row && (row.played || paused.has(videoId))) {
      skipped += 1;
      continue;
    }
    await upsertPlaystateEverywhere(userUUID, videoId, row ? { positionMs: 0, played: true } : { positionMs: 0, played: true, lastPlayedAt: null });
    added += 1;
  }

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

let running = false;

export async function syncAllPlaystate(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const uuids: string[] = await database.getAllUserUUIDs();
    let users = 0;
    let added = 0;

    for (const userUUID of uuids) {
      let config: any;
      try {
        config = await database.getUserConfig(userUUID);
      } catch {
        continue;
      }
      if (!config || !sourceFor(config)) continue;

      try {
        const result = await syncPlaystateFor(userUUID, config);
        users += 1;
        added += result.added;
      } catch (error: any) {
        logger.debug(`Playstate sync failed for ${userUUID}: ${error?.message || error}`);
      }
    }

    if (added) logger.info(`Playstate sync: ${added} title(s) taken from trackers across ${users} configuration(s)`);
  } finally {
    running = false;
  }
}

export function startPlaystateSync(): void {
  const intervalMs = envInt('JELLYFIN_PLAYSTATE_SYNC_INTERVAL', 30 * 60, 60) * 1000;
  const initialDelayMs = envInt('JELLYFIN_PLAYSTATE_SYNC_DELAY', 2 * 60, 0) * 1000;

  setTimeout(() => {
    syncAllPlaystate().catch(() => undefined);
    setInterval(() => syncAllPlaystate().catch(() => undefined), intervalMs).unref?.();
  }, initialDelayMs).unref?.();
}
