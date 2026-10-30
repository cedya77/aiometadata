import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../utils/envNumber';
import { enqueueTrackerWrites, startWindowSeconds, type OutboxJob } from './trackerOutbox';
import type { WatchTrackingService } from './watchTracking';

const logger = consola.withTag('Playback');

export const PLAYBACK_EVENTS = ['start', 'progress', 'pause', 'stop', 'played', 'unplayed'] as const;
export type PlaybackEvent = (typeof PLAYBACK_EVENTS)[number];

/** Contract version of the `watch_state` resource this addon answers. */
export const WATCH_STATE_VERSION = 2;

export const PLAYBACK_MANIFEST_EVENTS = ['start', 'pause', 'stop', 'played', 'unplayed'];

/** Changes to a title rather than a video, sent only to an addon that lists them. */
export const TITLE_EVENTS = ['watchlisted', 'unwatchlisted', 'dropped', 'undropped', 'rated', 'unrated'] as const;
export const WATCH_STATE_PUSH_EVENTS = [...PLAYBACK_MANIFEST_EVENTS, ...TITLE_EVENTS];

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
 * The sender derives its idempotency key from the item, the event kind and the
 * position or timestamp, and repeats it across retries. Some clients also report
 * a single stop twice in two shapes, so a repeat is expected rather than a fault.
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

// Kept apart from the sender's idempotency ids: this one remembers the last
// decision about a title, not that a particular message was seen.
const decisions = new LRUCache<string, { intent: 'watched' | 'unwatched'; at: number }>({
  max: envInt('PLAYBACK_DEDUPE_MAX', 10000, 1),
  ttl: envInt('PLAYBACK_DEDUPE_TTL', 6 * 60 * 60, 60) * 1000,
});

/** A mark repeating a decision older than this is the user's, not an echo. */
function markRepeatMs(): number {
  return envInt('PLAYBACK_MARK_REPEAT_WINDOW', 300, 0) * 1000;
}

export function isDuplicate(userUUID: string, id: string | null): boolean {
  if (!id) return false;
  const key = `${userUUID}:${id}`;
  if (seen.has(key)) return true;
  seen.set(key, true);
  return false;
}

// Some clients send a finished stop and a mark-watched for one viewing, and the
// sender's key cannot collapse them because it carries the event kind.
export function isRepeatWatched(userUUID: string, report: PlaybackReport): boolean {
  const video = report.videoId ?? report.metaId;
  if (!video) return false;

  // Only a repeat of the same decision is dropped. Marking something watched and
  // then unwatched is two decisions about one title, and collapsing them left
  // the second one unrecorded.
  const intent = intentOf(report) === 'unwatched' ? 'unwatched' : 'watched';
  const key = `watched:${userUUID}:${video}`;
  const previous = decisions.get(key);
  const now = Date.now();
  decisions.set(key, { intent, at: now });

  if (!previous || previous.intent !== intent) return false;
  if (report.event === 'played' || report.event === 'unplayed') return now - previous.at < markRepeatMs();
  return true;
}

/** Keeps one user's events apart from another's; the installation keeps the key it always had. */
export function viewerScope(userUUID: string, config: any): string {
  const { profileKey } = require('./jellyfin/profiles');
  const key = profileKey(config);
  return key ? `${userUUID}:${key}` : userUUID;
}

function writesTrackersFor(config: any): boolean {
  return require('./jellyfin/profiles').writesTrackers(config);
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
// Acknowledged at once; the sender gives up on the request after 15 seconds.
export async function handleBulkPlaybackReport(
  type: string,
  id: string,
  body: any,
  config: any,
  userUUID: string
): Promise<PlaybackOutcome> {
  const event = String(body?.event || '');
  if (type !== 'series' || (event !== 'played' && event !== 'unplayed')) {
    return { status: 400, reason: 'unrecognised bulk event' };
  }
  const videos = (Array.isArray(body?.videos) ? body.videos : [])
    .map((v: any) => (typeof v?.videoId === 'string' ? v.videoId : null))
    .filter((v: string | null): v is string => !!v);
  if (!videos.length) return { status: 400, reason: 'no videos' };

  if (isDuplicate(viewerScope(userUUID, config), typeof body?.id === 'string' && body.id ? body.id : null)) return { status: 204 };

  const idMapper = require('./id-mapper');
  const base = String(body?.metaId || id).split(':')[0];
  const mapping = base.startsWith('tt') ? idMapper.getMappingByImdbId(base) : null;
  if (mapping && !idMapper.mappingIsType(mapping, 'series')) return { status: 400, reason: 'not a series' };

  logger.info(`${event} ${type}/${id}: ${videos.length} video(s) (${body?.scope || 'bulk'} ${body?.part ?? 1}/${body?.parts ?? 1})`);

  const { shouldTrackServiceMediaType } = require('./watchTracking');
  const method = event === 'played' ? 'addToHistory' : 'removeFromHistory';
  const scope = body?.scope === 'season' ? 'season' : 'series';
  const item = String(body?.metaId || id);
  const jobs: OutboxJob[] = [];
  for (const service of ['simkl', 'mdblist'] as const) {
    if (shouldTrackServiceMediaType(config, service, 'series')) jobs.push({ service, op: 'episodes', item, payload: { videos, method, scope } });
  }
  // PublicMetaDB clears a season in one call but records a watch one episode at a time,
  // each a play of its own, so an episode it already lists is not played again.
  if (shouldTrackServiceMediaType(config, 'publicmetadb', 'series')) {
    if (method === 'removeFromHistory') jobs.push({ service: 'publicmetadb', op: 'episodes', item, payload: { videos, method, scope } });
    else {
      const listed = await pmdbListed(config, videos);
      for (const video of videos) {
        if (!listed.has(video)) jobs.push({ service: 'publicmetadb', op: 'episodes', item, coalesce: `history:${video}`, payload: { videos: [video], method, scope } });
      }
    }
  }
  // A count-based list only needs the furthest episode watched, or the span unwatched.
  const ordered = [...videos].sort((a, b) => episodeOrder(a) - episodeOrder(b));
  const edge = (event === 'played' ? ordered[ordered.length - 1] : ordered[0]) as string;
  const through = event === 'unplayed' ? ordered[ordered.length - 1] : undefined;
  const { parseMediaId } = require('./subtitleHandler');
  const parsedEdge = parseMediaId(edge);
  if (parsedEdge) {
    const report: PlaybackReport = {
      id: null, event, at: null, metaId: body?.metaId ?? null, videoId: edge,
      positionMs: null, durationMs: null, played: event === 'played',
      season: parsedEdge.season ?? null, episode: parsedEdge.episode ?? null, ids: body?.ids ?? {},
    };
    for (const service of ['anilist', 'mal'] as const) {
      if (shouldTrackServiceMediaType(config, service, 'series')) jobs.push({ service, op: 'anime', item, coalesce: `anime:${item}`, payload: { type, id: edge, report, through } });
    }
  }
  if (writesTrackersFor(config)) await enqueueTrackerWrites(userUUID, config, jobs);

  return { status: 204 };
}

/** Which of these PublicMetaDB already lists as watched, where its library is mirrored here. */
async function pmdbListed(config: any, videos: string[]): Promise<Set<string>> {
  const { credentialFor } = require('./jellyfin/trackerSource');
  const credential = credentialFor(config, 'publicmetadb');
  if (!credential) return new Set();
  const { sourceKeyFor } = require('./jellyfin/trackerMirror');
  const database: any = require('./database');
  const rows: Array<{ video_id: string }> = await database.watchIndexAmong(sourceKeyFor('publicmetadb', credential), videos).catch(() => []);
  return new Set(rows.map((row) => row.video_id));
}

/** A favourite or a rating on a movie or show, written to the trackers the Jellyfin server writes. */
async function handleTitleReport(
  type: string,
  id: string,
  body: any,
  config: any,
  userUUID: string
): Promise<PlaybackOutcome> {
  const event = String(body.event);
  const metaId = typeof body.metaId === 'string' && body.metaId ? body.metaId : id;
  if (type !== 'movie' && type !== 'series') return { status: 400, reason: 'unsupported type' };
  if ((event === 'dropped' || event === 'undropped') && type !== 'series') return { status: 400, reason: 'not a series' };
  if (isDuplicate(viewerScope(userUUID, config), typeof body.id === 'string' && body.id ? body.id : null)) return { status: 204 };

  const ids = body.ids && typeof body.ids === 'object' ? body.ids : {};
  const anime = Boolean(ids.kitsu || ids.mal || ids.anilist || ids.anidb) || /^(kitsu|mal|anilist|anidb):/.test(metaId);
  const descriptor = { k: type, t: anime ? 'anime' : type, i: metaId };
  logger.info(`${event} ${type}/${metaId}`);

  if (event === 'rated' || event === 'unrated') {
    const scope = String(body.scope || type);
    const season = num(body.season);
    const episode = num(body.episode);
    if (scope === 'episode' && episode === null) return { status: 400, reason: 'no episode' };
    if (scope === 'season' && season === null) return { status: 400, reason: 'no season' };
    const { ratingFrom, rateItem } = require('./jellyfin/ratings');
    const rated =
      scope === 'episode' ? { k: 'episode', t: descriptor.t, i: metaId, s: season, e: episode }
      : scope === 'season' ? { k: 'season', t: descriptor.t, i: metaId, s: season }
      : descriptor;
    if (!(await rateItem(userUUID, config, rated, event === 'rated' ? ratingFrom(body.rating) : null))) return { status: 400, reason: 'unknown title' };
    return { status: 204 };
  }

  if (event === 'watchlisted' || event === 'unwatchlisted') {
    const { setWatchlisted } = require('./jellyfin/watchlist');
    if (!(await setWatchlisted(userUUID, config, descriptor, event === 'watchlisted'))) return { status: 400, reason: 'unknown title' };
    return { status: 204 };
  }

  const { rateSeries } = require('./jellyfin/dropped');
  await rateSeries(userUUID, config, descriptor, event === 'dropped' ? false : true);
  return { status: 204 };
}

function episodeOrder(videoId: string): number {
  const parts = videoId.split(':').map(Number);
  const episode = parts.pop() ?? 0;
  const season = parts.length >= 2 ? parts.pop() ?? 0 : 0;
  return season * 100000 + episode;
}

export async function handlePlaybackReport(
  type: string,
  id: string,
  body: any,
  config: any,
  userUUID: string
): Promise<PlaybackOutcome> {
  if ((TITLE_EVENTS as readonly string[]).includes(String(body?.event || ''))) return handleTitleReport(type, id, body, config, userUUID);
  const scope = String(body?.scope || '');
  if (scope === 'season' || scope === 'series') return handleBulkPlaybackReport(type, id, body, config, userUUID);

  const report = parsePlaybackReport(body);
  if (!report) {
    logger.debug(`Unusable playback body for ${type}/${id}`);
    return { status: 400, reason: 'unrecognised event' };
  }

  if (isDuplicate(viewerScope(userUUID, config), report.id)) {
    logger.debug(`Duplicate ${report.event} for ${type}/${id} (${report.id})`);
    return { status: 204 };
  }

  // A film's id played through a series page would credit the franchise show.
  if (type === 'series') {
    const idMapper = require('./id-mapper');
    const base = String(report.metaId || id).split(':')[0];
    const mapping = base.startsWith('tt') ? idMapper.getMappingByImdbId(base) : null;
    if (mapping && !idMapper.mappingIsType(mapping, 'series')) {
      logger.debug(`Rejected series event on a film's id: ${id}`);
      return { status: 400, reason: 'not a series' };
    }
  }

  const progress =
    report.positionMs !== null && report.durationMs
      ? Math.min(100, Math.max(0, Math.round((report.positionMs / report.durationMs) * 100)))
      : null;

  logger.info(
    `${report.event} ${type}/${id}` +
      (report.season !== null ? ` S${report.season}E${report.episode}` : '') +
      (progress !== null ? ` at ${progress}%` : '') +
      (report.played !== null ? ` played=${report.played}` : '')
  );

  // Every decision is recorded, including a reversal: otherwise the last one
  // remembered stays "watched" and a mark that follows an unmark reads as a
  // repeat of the first and never reaches a tracker.
  const intent = intentOf(report);
  if ((intent === 'watched' || intent === 'unwatched') && isRepeatWatched(viewerScope(userUUID, config), report)) {
    logger.debug(`Already recorded as ${intent}: ${type}/${id}`);
    return { status: 204 };
  }

  // An unknown progress is not zero: a pause reported at 0% would move the resume point to the start.
  if (intent === 'paused' && progress === null) {
    logger.debug(`Pause without a duration for ${type}/${id}, nothing to save`);
    return { status: 204 };
  }

  if (report.event === 'start' && type === 'series' && report.metaId) {
    const { undropOnWatch } = require('./jellyfin/dropped');
    undropOnWatch(userUUID, config, [report.metaId]);
  }

  if (writesTrackersFor(config)) {
    const { playedThresholdFor } = require('./jellyfin/playstate');
    const watchedAt = await playedThresholdFor(userUUID, config?.jellyfinProfileId ?? null);
    await enqueueTrackerWrites(userUUID, config, planReport(type, id, report, progress, config, watchedAt));
  }

  return { status: 204 };
}

/**
 * One write per tracker and per kind, so a retry repeats only the write that
 * failed. A tracker that holds plays rather than a flag would otherwise count a
 * watch twice because the resume clear after it failed.
 */
function planReport(type: string, id: string, report: PlaybackReport, progress: number | null, config: any, watchedAt: number): OutboxJob[] {
  const { parseMediaId } = require('./subtitleHandler');
  const { shouldTrackServiceMediaType, normalizeWatchTrackingMediaType } = require('./watchTracking');
  const parsedId = parseMediaId(id);
  const mediaType = parsedId ? normalizeWatchTrackingMediaType(type, parsedId.type) : null;
  if (!mediaType) return [];

  const intent = intentOf(report);
  const item = String(report.metaId || id);
  const payload = { type, id, report, progress, watchedAt };
  // A mark-watched on an item nobody played goes to history, not the scrobble lifecycle.
  const credited = intent === 'watched' && report.event !== 'stop';
  // A watch only hides a tracker's paused session; it has to be deleted or an unwatch revives it.
  // A mark ends a session the same way a finished stop does, and an unmark starts the title over.
  const clears = report.event === 'played' || report.event === 'unplayed' || (report.event === 'stop' && intent === 'watched');

  const jobs: OutboxJob[] = [];
  for (const service of ['simkl', 'mdblist', 'publicmetadb'] as const) {
    if (!shouldTrackServiceMediaType(config, service, mediaType)) continue;
    const scrobbles = service === 'publicmetadb'
      ? (report.event === 'stop' || report.event === 'pause') && (intent === 'partial' || intent === 'watched' || intent === 'paused')
      : intent !== 'none' && intent !== 'unwatched' && !credited;
    // A later start or pause replaces one still waiting; a stop is never replaced, since it may be the watch.
    if (scrobbles) {
      jobs.push({
        service, op: 'scrobble', item, payload,
        coalesce: report.event === 'stop' ? null : `scrobble:${id}`,
        within: intent === 'watching' ? startWindowSeconds() : undefined,
      });
    }
    if (credited) jobs.push({ service, op: 'credit', item, payload, coalesce: `history:${id}` });
    if (intent === 'unwatched') jobs.push({ service, op: 'unwatch', item, payload, coalesce: `history:${id}` });
    if (credited || clears) jobs.push({ service, op: 'clearResume', item, payload, coalesce: `resume:${id}` });
  }
  if (intent === 'watched' || intent === 'unwatched') {
    for (const service of ['anilist', 'mal'] as const) {
      if (shouldTrackServiceMediaType(config, service, mediaType)) jobs.push({ service, op: 'anime', item, payload, coalesce: `anime:${id}` });
    }
  }
  return jobs;
}

type ReportPayload = { type: string; id: string; report: PlaybackReport; progress: number | null; through?: string; watchedAt?: number };

export async function deliverScrobble(service: WatchTrackingService, p: ReportPayload, config: any): Promise<void> {
  if (service === 'simkl') await scrobbleSimkl(p.type, p.id, p.report, p.progress, config, p.watchedAt);
  else if (service === 'mdblist') await scrobbleMdblist(p.type, p.id, p.report, p.progress, config);
  else if (service === 'publicmetadb') await reportPublicMetaDB(p.type, p.id, p.report, config);
}

function trackedMediaId(p: Pick<ReportPayload, 'type' | 'id'>): any | null {
  const { parseMediaId } = require('./subtitleHandler');
  const { normalizeWatchTrackingMediaType } = require('./watchTracking');
  const parsedId = parseMediaId(p.id);
  if (!parsedId || !normalizeWatchTrackingMediaType(p.type, parsedId.type)) return null;
  return parsedId;
}

export async function deliverCredit(service: WatchTrackingService, p: ReportPayload, config: any): Promise<void> {
  const parsedId = trackedMediaId(p);
  if (parsedId) await require('./subtitleHandler').creditHistory(parsedId, config, service);
}

export async function deliverUnwatch(service: WatchTrackingService, p: ReportPayload, config: any): Promise<void> {
  const parsedId = trackedMediaId(p);
  if (parsedId) await require('./subtitleHandler').unwatch(parsedId, config, service);
}

export async function deliverWatchDate(service: WatchTrackingService, p: { type: string; id: string; from: number; to: number; latest?: number | null; apart?: boolean }, config: any): Promise<void> {
  const parsedId = trackedMediaId(p);
  if (parsedId) await require('./subtitleHandler').redateHistory(parsedId, config, service, p);
}

export async function deliverCatchUp(service: WatchTrackingService, p: { type: string; id: string; at: number }, config: any, userUUID: string): Promise<void> {
  if (service === 'anilist' || service === 'mal') {
    const report: PlaybackReport = { id: null, event: 'played', at: p.at, metaId: null, videoId: p.id, positionMs: null, durationMs: null, played: true, season: null, episode: null, ids: {} };
    await advanceAnimeLists(p.type, p.id, report, config, userUUID, service);
    return;
  }
  const parsedId = trackedMediaId(p);
  if (parsedId) await require('./subtitleHandler').creditHistory(parsedId, config, service, p.at);
}

export async function deliverCatchUps(service: WatchTrackingService, p: { items?: any[]; rewatch?: boolean }, config: any, userUUID: string): Promise<void> {
  const items = Array.isArray(p.items) ? p.items : [];
  const { ACCOUNT_SERVICES } = require('./accounts');
  const { trackerName, trackerOf } = require('./trackers');
  const batch = trackerOf(service)?.writeWatches;
  const credential = batch ? config.apiKeys?.[ACCOUNT_SERVICES[service].key] : null;
  if (!items.length || !credential) return;
  const { noteTrackerCall } = require('../utils/trackerCalls');
  const outcome = await batch.write(items, credential, config, p.rewatch === true);
  const name = trackerName(service);
  const url = batch.url;
  if (outcome.wait) {
    noteTrackerCall(url, 429, outcome.error ?? 'waiting for the allowance', null, Date.now() + outcome.wait);
    return;
  }
  if (!outcome.sent && outcome.failed) {
    noteTrackerCall(url, 404, `none of ${items.length} found on ${name}`);
    return;
  }
  const lost = new Set<number>(outcome.lost ?? []);
  if (!lost.size) return;
  const missed = items.filter((_, i) => lost.has(i));
  p.items = items.filter((_, i) => !lost.has(i));
  const { sourceKeyFor } = require('./jellyfin/trackerMirror');
  const { noteActivity } = require('./trackerActivity');
  const { accountOwner, credentialOf } = require('./accounts');
  const videos = missed.map((entry: any) => entry?.ids?.[0]).filter(Boolean);
  await noteActivity({
    sourceKey: sourceKeyFor(service, credentialOf(config, service)),
    service,
    kind: 'failed',
    userUUID,
    profile: accountOwner(config),
    op: 'catchUps',
    video: videos[0] ?? null,
    detail: { verb: videos.length === 1 ? 'Sent a missed watch' : `Sent ${videos.length} missed watches`, count: videos.length, videos, status: 404, reason: `not found on ${name}` },
  });
}

export async function deliverClearResume(service: WatchTrackingService, p: ReportPayload, config: any): Promise<void> {
  const { parseMediaId, clearResumePoint } = require('./subtitleHandler');
  const parsedId = parseMediaId(p.id);
  if (parsedId) await clearResumePoint(parsedId, config, service);
}

export async function deliverAnime(service: WatchTrackingService, p: ReportPayload, config: any, userUUID: string): Promise<void> {
  await advanceAnimeLists(p.type, p.id, p.report, config, userUUID, service, p.through);
}

/**
 * A `played` decision is the sender's, taken at its own threshold, so it is
 * honoured rather than recomputed here: a stop it calls played is reported at a
 * progress Simkl will mark watched, whatever the position said.
 */
function watchedProgressFor(report: PlaybackReport, progress: number | null): number {
  // Intent, not event: a mark-watched carries no position, so reading the event
  // name here would report it at 0% and have every service store a resume point
  // instead of a watch.
  if (intentOf(report) === 'watched') {
    return progress !== null && progress >= WATCHED_AT ? progress : 100;
  }
  return progress ?? 0;
}

/** Simkl and MDBList both mark an item watched on stop at 80 or above. */
const WATCHED_AT = 80;

export type PlaybackIntent = 'watching' | 'paused' | 'partial' | 'watched' | 'unwatched' | 'none';

export function intentOf(report: PlaybackReport): PlaybackIntent {
  switch (report.event) {
    case 'start':
      return 'watching';
    case 'pause':
      return 'paused';
    case 'stop':
      return report.played === true ? 'watched' : 'partial';
    case 'played':
      return 'watched';
    case 'unplayed':
      return 'unwatched';
    default:
      return 'none';
  }
}

/**
 * MDBList uses the same lifecycle and the same 80% rule as Simkl, so a stop it
 * calls played is reported at a progress MDBList will mark watched. Its check-in
 * conflicts with an active scrobble session (409), but the two never run
 * together: the toggle picks one path or the other.
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
 * to report on pause, stop or close and never during playback. A pause or a stop saves the
 * position, and only a played one is also written to history.
 */
async function reportPublicMetaDB(
  type: string,
  id: string,
  report: PlaybackReport,
  config: any
): Promise<void> {
  const intent = intentOf(report);
  if (intent !== 'partial' && intent !== 'watched' && intent !== 'paused') return;
  // Only a stop or a pause has a position to save. A bare mark-watched is
  // credited through history, and going through here as well would report it twice.
  if (report.event !== 'stop' && report.event !== 'pause') return;

  const { parseMediaId, checkinPublicMetaDB } = require('./subtitleHandler');
  const { shouldTrackServiceMediaType, normalizeWatchTrackingMediaType } = require('./watchTracking');

  const parsedId = parseMediaId(id);
  if (!parsedId) return;

  const mediaType = normalizeWatchTrackingMediaType(type, parsedId.type);
  if (!mediaType || !shouldTrackServiceMediaType(config, 'publicmetadb', mediaType)) return;

  await checkinPublicMetaDB(parsedId, config, {
    action: 'stop',
    played: intent === 'watched',
    positionMs: report.positionMs ?? 0,
    runtimeMs: report.durationMs ?? 0,
  });
}

async function advanceAnimeLists(
  type: string,
  id: string,
  report: PlaybackReport,
  config: any,
  userUUID: string,
  only?: WatchTrackingService,
  through?: string
): Promise<void> {
  const intent = intentOf(report);
  if (intent !== 'watched' && intent !== 'unwatched') return;
  const unwatched = intent === 'unwatched';

  const { parseMediaId } = require('./subtitleHandler');
  const { shouldTrackServiceMediaType, normalizeWatchTrackingMediaType } = require('./watchTracking');

  const parsedId = parseMediaId(id);
  if (!parsedId) return;
  const parsedThrough = unwatched && through ? parseMediaId(through) : null;

  const mediaType = normalizeWatchTrackingMediaType(type, parsedId.type);
  if (!mediaType) return;

  const work: Promise<any>[] = [];

  if ((!only || only === 'anilist') && shouldTrackServiceMediaType(config, 'anilist', mediaType)) {
    const anilistTracker = require('./anilistTracker');
    work.push(
      anilistTracker.trackAnimeProgress(parsedId, config, userUUID, unwatched, parsedThrough).catch((error: any) => {
        logger.error(`AniList tracking failed for ${id}: ${error.message}`);
      })
    );
  }

  if ((!only || only === 'mal') && shouldTrackServiceMediaType(config, 'mal', mediaType)) {
    const malTracker = require('./malTracker');
    work.push(
      malTracker.trackAnimeProgress(parsedId, config, userUUID, unwatched, parsedThrough).catch((error: any) => {
        logger.error(`MAL tracking failed for ${id}: ${error.message}`);
      })
    );
  }

  await Promise.all(work);
}

async function scrobbleMdblist(
  type: string,
  id: string,
  report: PlaybackReport,
  progress: number | null,
  config: any
): Promise<void> {
  const intent = intentOf(report);
  if (intent === 'none' || intent === 'unwatched') return;
  if (intent === 'watched' && report.event !== 'stop') return;

  const { parseMediaId, trackMdblistWatchStatus } = require('./subtitleHandler');
  const { shouldTrackServiceMediaType, normalizeWatchTrackingMediaType } = require('./watchTracking');

  const parsedId = parseMediaId(id);
  if (!parsedId) return;

  const mediaType = normalizeWatchTrackingMediaType(type, parsedId.type);
  if (!mediaType || !shouldTrackServiceMediaType(config, 'mdblist', mediaType)) return;

  await trackMdblistWatchStatus(parsedId, config, {
    action: intent === 'watching' ? 'start' : intent === 'paused' ? 'pause' : 'stop',
    progress: watchedProgressFor(report, progress),
  });
}

async function scrobbleSimkl(
  type: string,
  id: string,
  report: PlaybackReport,
  progress: number | null,
  config: any,
  watchedAt?: number
): Promise<void> {
  const intent = intentOf(report);
  if (intent === 'none' || intent === 'unwatched') return;
  // A bare mark-watched is credited through history, not the scrobble lifecycle.
  if (intent === 'watched' && report.event !== 'stop') return;

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
    action: intent === 'watching' ? 'start' : intent === 'paused' ? 'pause' : 'stop',
    progress: watchedProgressFor(report, progress),
    minProgress: watchedAt,
  });
}
