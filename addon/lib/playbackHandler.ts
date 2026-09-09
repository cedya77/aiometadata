import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../utils/envNumber';

const logger = consola.withTag('Playback');

export const PLAYBACK_EVENTS = ['start', 'progress', 'stop', 'played', 'unplayed'] as const;
export type PlaybackEvent = (typeof PLAYBACK_EVENTS)[number];

/** The id prefixes parseMediaId accepts, which is what we can act on. */
export const PLAYBACK_ID_PREFIXES = ['tt', 'tmdb:', 'tvdb:', 'trakt:', 'kitsu:'];

export interface PlaybackReport {
  id: string | null;
  event: PlaybackEvent;
  at: number | null;
  metaId: string | null;
  videoId: string | null;
  positionMs: number | null;
  durationMs: number | null;
  played: boolean | null;
  season: number | null;
  episode: number | null;
  ids: Record<string, any>;
}

/**
 * The sender derives its idempotency key from the item, the event kind and a
 * one-minute bucket, and repeats it across retries. Some clients also report a
 * single stop twice in two shapes, so a repeat is expected rather than a fault.
 */
const seen = new LRUCache<string, true>({
  max: envInt('PLAYBACK_DEDUPE_MAX', 10000, 1),
  ttl: envInt('PLAYBACK_DEDUPE_TTL', 6 * 60 * 60, 60) * 1000,
});

function num(value: any): number | null {
  const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePlaybackReport(body: any): PlaybackReport | null {
  if (!body || typeof body !== 'object') return null;

  const event = String(body.event || '');
  if (!(PLAYBACK_EVENTS as readonly string[]).includes(event)) return null;

  return {
    id: typeof body.id === 'string' && body.id ? body.id : null,
    event: event as PlaybackEvent,
    at: num(body.at),
    metaId: typeof body.metaId === 'string' ? body.metaId : null,
    videoId: typeof body.videoId === 'string' ? body.videoId : null,
    positionMs: num(body.positionMs),
    durationMs: num(body.durationMs),
    played: typeof body.played === 'boolean' ? body.played : null,
    season: num(body.season),
    episode: num(body.episode),
    ids: body.ids && typeof body.ids === 'object' ? body.ids : {},
  };
}

export function isDuplicate(userUUID: string, report: PlaybackReport): boolean {
  if (!report.id) return false;
  const key = `${userUUID}:${report.id}`;
  if (seen.has(key)) return true;
  seen.set(key, true);
  return false;
}

export interface PlaybackOutcome {
  status: number;
  reason?: string;
}

/**
 * Acts on one reported playback event. The scrobble calls land here; until they
 * do, an event is accepted and recorded so the sender sees a healthy sink and
 * stops retrying.
 */
export async function handlePlaybackReport(
  type: string,
  id: string,
  body: any,
  config: any,
  userUUID: string
): Promise<PlaybackOutcome> {
  const report = parsePlaybackReport(body);
  if (!report) {
    logger.debug(`Unusable playback body for ${type}/${id}`);
    return { status: 400, reason: 'unrecognised event' };
  }

  if (isDuplicate(userUUID, report)) {
    logger.debug(`Duplicate ${report.event} for ${type}/${id} (${report.id})`);
    return { status: 204 };
  }

  const progress =
    report.positionMs !== null && report.durationMs
      ? Math.round((report.positionMs / report.durationMs) * 100)
      : null;

  logger.info(
    `${report.event} ${type}/${id}` +
      (report.season !== null ? ` S${report.season}E${report.episode}` : '') +
      (progress !== null ? ` at ${progress}%` : '') +
      (report.played !== null ? ` played=${report.played}` : '')
  );

  await Promise.all([
    scrobbleSimkl(type, id, report, progress, config).catch((error: any) => {
      logger.error(`Simkl scrobble failed for ${id}: ${error.message}`);
    }),
    scrobbleMdblist(type, id, report, progress, config).catch((error: any) => {
      logger.error(`MDBList scrobble failed for ${id}: ${error.message}`);
    }),
    scrobbleTrakt(type, id, report, progress, config).catch((error: any) => {
      logger.error(`Trakt scrobble failed for ${id}: ${error.message}`);
    }),
    advanceAnimeLists(type, id, report, config, userUUID).catch((error: any) => {
      logger.error(`Anime list update failed for ${id}: ${error.message}`);
    }),
    reportPublicMetaDB(type, id, report, config).catch((error: any) => {
      logger.error(`PublicMetaDB report failed for ${id}: ${error.message}`);
    }),
  ]);

  return { status: 204 };
}

/**
 * A `played` decision is the sender's, taken at its own threshold, so it is
 * honoured rather than recomputed here: a stop it calls played is reported at a
 * progress Simkl will mark watched, whatever the position said.
 */
function watchedProgressFor(report: PlaybackReport, progress: number | null): number {
  if (report.event === 'stop' && report.played === true) {
    return progress !== null && progress >= WATCHED_AT ? progress : 100;
  }
  return progress ?? 0;
}

/** Simkl, MDBList and Trakt all mark an item watched on stop at 80 or above. */
const WATCHED_AT = 80;

/** Trakt answers 422 to a scrobble under 1% and records nothing. */
const TRAKT_MIN_PROGRESS = 1;

/**
 * MDBList uses the same lifecycle and the same 80% rule as Simkl, so a stop it
 * calls played is reported at a progress MDBList will mark watched. Its check-in
 * conflicts with an active scrobble session (409), but the two never run
 * together: the toggle picks one path or the other.
 */
/**
 * Trakt shares the 80% rule, and ignores a scrobble under 1% with a 422, so a
 * stop at the very start is not worth sending: nothing is recorded either way
 * and the failure would read as an error.
 */
/**
 * AniList and MAL hold list state, not playback state: their progress is a
 * count of episodes finished, with no session to start or resume. So the only
 * event that means anything is a stop the sender calls played, and the trackers
 * need no options, only to be called at the right moment rather than when a
 * title was merely opened.
 */
/**
 * PublicMetaDB has no session, so a start means nothing to it: its own docs say
 * to report on pause, stop or close and never during playback. A stop saves the
 * position, and only a played one is also written to history.
 */
async function reportPublicMetaDB(
  type: string,
  id: string,
  report: PlaybackReport,
  config: any
): Promise<void> {
  if (report.event !== 'stop') return;

  const { parseMediaId, checkinPublicMetaDB } = require('./subtitleHandler');
  const { shouldTrackServiceMediaType, normalizeWatchTrackingMediaType } = require('./watchTracking');

  const parsedId = parseMediaId(id);
  if (!parsedId) return;

  const mediaType = normalizeWatchTrackingMediaType(type, parsedId.type);
  if (!mediaType || !shouldTrackServiceMediaType(config, 'publicmetadb', mediaType)) return;

  await checkinPublicMetaDB(parsedId, config, {
    action: 'stop',
    played: report.played === true,
    positionMs: report.positionMs ?? 0,
    runtimeMs: report.durationMs ?? 0,
  });
}

async function advanceAnimeLists(
  type: string,
  id: string,
  report: PlaybackReport,
  config: any,
  userUUID: string
): Promise<void> {
  if (report.event !== 'stop' || report.played !== true) return;

  const { parseMediaId } = require('./subtitleHandler');
  const { shouldTrackServiceMediaType, normalizeWatchTrackingMediaType } = require('./watchTracking');

  const parsedId = parseMediaId(id);
  if (!parsedId) return;

  const mediaType = normalizeWatchTrackingMediaType(type, parsedId.type);
  if (!mediaType) return;

  const work: Promise<any>[] = [];

  if (shouldTrackServiceMediaType(config, 'anilist', mediaType)) {
    const anilistTracker = require('./anilistTracker');
    work.push(
      anilistTracker.trackAnimeProgress(parsedId, config, userUUID).catch((error: any) => {
        logger.error(`AniList tracking failed for ${id}: ${error.message}`);
      })
    );
  }

  if (shouldTrackServiceMediaType(config, 'mal', mediaType)) {
    const malTracker = require('./malTracker');
    work.push(
      malTracker.trackAnimeProgress(parsedId, config, userUUID).catch((error: any) => {
        logger.error(`MAL tracking failed for ${id}: ${error.message}`);
      })
    );
  }

  await Promise.all(work);
}

async function scrobbleTrakt(
  type: string,
  id: string,
  report: PlaybackReport,
  progress: number | null,
  config: any
): Promise<void> {
  if (report.event !== 'start' && report.event !== 'stop') return;

  const { parseMediaId, checkinTrakt } = require('./subtitleHandler');
  const { shouldTrackServiceMediaType, normalizeWatchTrackingMediaType } = require('./watchTracking');

  const parsedId = parseMediaId(id);
  if (!parsedId) return;

  const mediaType = normalizeWatchTrackingMediaType(type, parsedId.type);
  if (!mediaType || !shouldTrackServiceMediaType(config, 'trakt', mediaType)) return;

  const value = watchedProgressFor(report, progress);
  if (report.event === 'stop' && value < TRAKT_MIN_PROGRESS) {
    logger.debug(`Skipping Trakt stop for ${id}, ${value}% is below the 1% Trakt accepts`);
    return;
  }

  await checkinTrakt(parsedId, config, { action: report.event, progress: value });
}

async function scrobbleMdblist(
  type: string,
  id: string,
  report: PlaybackReport,
  progress: number | null,
  config: any
): Promise<void> {
  if (report.event !== 'start' && report.event !== 'stop') return;

  const { parseMediaId, trackMdblistWatchStatus } = require('./subtitleHandler');
  const { shouldTrackServiceMediaType, normalizeWatchTrackingMediaType } = require('./watchTracking');

  const parsedId = parseMediaId(id);
  if (!parsedId) return;

  const mediaType = normalizeWatchTrackingMediaType(type, parsedId.type);
  if (!mediaType || !shouldTrackServiceMediaType(config, 'mdblist', mediaType)) return;

  await trackMdblistWatchStatus(parsedId, config, {
    action: report.event,
    progress: watchedProgressFor(report, progress),
  });
}

async function scrobbleSimkl(
  type: string,
  id: string,
  report: PlaybackReport,
  progress: number | null,
  config: any
): Promise<void> {
  if (report.event !== 'start' && report.event !== 'stop') return;

  const { parseMediaId, checkinSimkl } = require('./subtitleHandler');
  const { shouldTrackServiceMediaType, normalizeWatchTrackingMediaType } = require('./watchTracking');

  const parsedId = parseMediaId(id);
  if (!parsedId) {
    logger.debug(`Unsupported id for Simkl: ${id}`);
    return;
  }

  const mediaType = normalizeWatchTrackingMediaType(type, parsedId.type);
  if (!mediaType || !shouldTrackServiceMediaType(config, 'simkl', mediaType)) return;

  await checkinSimkl(parsedId, config, {
    action: report.event,
    progress: watchedProgressFor(report, progress),
  });
}
