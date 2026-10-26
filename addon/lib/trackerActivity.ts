import { envInt } from '../utils/envNumber';

const consola = require('consola');
const logger = consola.withTag('TrackerActivity');

export type ActivityKind = 'read' | 'readFailed' | 'sent' | 'retry' | 'failed' | 'dropped';

export interface ActivityNote {
  sourceKey: string;
  service: string;
  kind: ActivityKind;
  userUUID?: string | null;
  profile?: string | null;
  op?: string | null;
  video?: string | null;
  detail?: Record<string, unknown>;
}

export interface JobSummary {
  verb: string;
  video: string | null;
  count: number;
  videos?: string[];
}

const videoOf = (value: any): string | null => (typeof value === 'string' ? value : value?.videoId ? String(value.videoId) : null);

export function summariseJob(op: string, payload: any, item: string | null = null): JobSummary {
  const p = payload ?? {};
  const one = (verb: string, video: unknown = p.id ?? item): JobSummary => ({ verb, video: videoOf(video), count: 1 });
  switch (op) {
    case 'scrobble': {
      const event = p.report?.event;
      if (event === 'start') return one('Started watching');
      if (event === 'pause') return one('Paused');
      if (event === 'stop' && p.report?.played === true) return one('Watched');
      if (event === 'stop') return one(Number.isFinite(p.progress) ? `Stopped at ${Math.round(p.progress)}%` : 'Stopped');
      return one('Played');
    }
    case 'credit': return one('Marked watched');
    case 'unwatch': return one('Marked unwatched');
    case 'redate': return one('Moved the watch date');
    case 'catchUp': return one('Sent a missed watch');
    case 'catchUps': {
      const videos = (Array.isArray(p.items) ? p.items : []).map((entry: any) => entry?.ids?.[0]).filter(Boolean) as string[];
      return { verb: videos.length === 1 ? 'Sent a missed watch' : `Sent ${videos.length} missed watches`, video: videos[0] ?? item, count: videos.length, videos };
    }
    case 'clearResume': return one('Cleared the resume point');
    case 'anime': return one('Moved anime progress');
    case 'episodes': {
      const videos = (Array.isArray(p.videos) ? p.videos : []).map(videoOf).filter(Boolean) as string[];
      const n = videos.length;
      const noun = n === 1 ? 'episode' : `${n} episodes`;
      return { verb: p.method === 'removeFromHistory' ? `Marked ${noun} unwatched` : `Marked ${noun} watched`, video: videos[0] ?? item, count: n };
    }
    case 'dropped': return one(p.dropped ? 'Dropped' : 'Picked back up', item);
    case 'watchlist': return one(p.listed ? 'Added to the watchlist' : 'Removed from the watchlist', item);
    case 'rate': return one(p.rating === null || p.rating === undefined ? 'Cleared the rating' : `Rated ${p.rating}`, p.video ?? item);
    default: return one(op, item);
  }
}

let prunedAt = 0;
const quietReads = new Map<string, number>();
const QUIET_READ_MS = 15 * 60 * 1000;

export function noteRead(sourceKey: string, service: string, outcome: { changed: boolean; full: boolean; ms: number } | { error: string }): void {
  if ('changed' in outcome && !outcome.changed && !outcome.full) {
    const last = quietReads.get(sourceKey) ?? 0;
    if (Date.now() - last < QUIET_READ_MS) return;
    quietReads.set(sourceKey, Date.now());
  }
  void noteActivity({ sourceKey, service, kind: 'error' in outcome ? 'readFailed' : 'read', detail: outcome });
}

export async function noteActivity(note: ActivityNote): Promise<void> {
  const database: any = require('./database');
  try {
    await database.addTrackerActivity({ ...note, at: Date.now() });
    if (Date.now() - prunedAt > 60 * 60 * 1000) {
      prunedAt = Date.now();
      await database.pruneTrackerActivity(Date.now() - envInt('JELLYFIN_TRACKER_ACTIVITY_DAYS', 14, 1) * 24 * 60 * 60 * 1000);
    }
  } catch (error: any) {
    logger.debug(`Could not note ${note.service} ${note.kind}: ${error?.message || error}`);
  }
}
