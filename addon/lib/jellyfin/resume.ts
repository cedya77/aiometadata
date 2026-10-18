import consola from 'consola';
import { createHash } from 'crypto';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { type Capable, credentialFor, resumeSourcesFor } from './trackerSource';
import { canonicalIds } from './canonicalIds';

const logger = consola.withTag('Jellyfin');

const idMapper: any = require('../id-mapper');
const animeListMapper: any = require('../anime-list-mapper');

export interface ResumeRow {
  /** Stremio id the meta is fetched with. */
  metaId: string;
  /** Exact video that was played, in the space the meta publishes. */
  videoId: string;
  /** `anime` where the anime mapping answered, so ids encode as the library does. */
  mediaType: 'anime' | 'series' | 'movie';
  kind: 'episode' | 'movie';
  progress: number;
  runtimeMinutes: number | null;
  updatedAt: number;
  /** Table rows only: when the row itself was last written. */
  writtenAt?: number;
  service?: Capable;
}

interface HeldRows {
  rows: ResumeRow[];
  /** The tracker's activity when the rows were read; null where it reports none. */
  fingerprint: string | null;
  at: number;
  ok: boolean;
}

const snapshots = new LRUCache<string, HeldRows>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: 24 * 60 * 60 * 1000,
});

const resumeMaxAgeMs = (): number => envInt('JELLYFIN_RESUME_MAX_AGE', 15 * 60, 60) * 1000;

const resumeFloorPercent = (): number => Math.min(envInt('JELLYFIN_MIN_RESUME_PERCENT', 0, 0), 49);

export function belowResumeFloor(positionMs: number, runtimeMs: number): boolean {
  const floor = resumeFloorPercent();
  return floor > 0 && runtimeMs > 0 && positionMs > 0 && positionMs < (runtimeMs * floor) / 100;
}

const belowTrackerFloor = (progress: number): boolean => progress < Math.min(2, resumeFloorPercent());

// A watch ends a paused session as surely as a pause starts one.
const MDBLIST_PLAYBACK_FIELDS = ['paused_at', 'episode_paused_at', 'watched_at', 'episode_watched_at', 'season_watched_at'];

/**
 * What the tracker says about its playback, read from the activity digest the watched
 * state already reads, so asking costs no call of its own. PublicMetaDB reports none.
 */
async function playbackFingerprint(service: Capable, credential: string, config: any): Promise<string | null> {
  try {
    if (service === 'simkl') {
      const { getSimklToken, fetchSimklLastActivities } = require('../../utils/simklUtils');
      const token = await getSimklToken(credential);
      if (!token?.access_token) return null;
      const activities = await fetchSimklLastActivities(token.access_token, config);
      return activities?.all ? String(activities.all) : null;
    }
    if (service === 'mdblist') {
      const { fetchMdblistLastActivities } = require('../../utils/mdbList');
      const activities = await fetchMdblistLastActivities(credential);
      return activities?.server_time ? MDBLIST_PLAYBACK_FIELDS.map((field) => activities[field] ?? '').join('|') : null;
    }
  } catch (error: any) {
    logger.debug(`Playback activity from ${service} unavailable: ${error?.message || error}`);
  }
  return null;
}

const inFlight = new Map<string, Promise<HeldRows>>();

const generations = new Map<string, number>();
export const generationOf = (userUUID: string): number => generations.get(userUUID) ?? 0;

/**
 * A tracker names an episode in its own space, which for anime is rarely the
 * one the meta publishes: a row stored as TVDB S3E11 is `kitsu:49002:11` here.
 * The anidb pivot is what the meta path itself uses, so ids come back matching
 * the items already in the library rather than a second, parallel identity.
 */
/**
 * What went wrong while resolving: an answer reached around a lookup that failed is
 * not the answer, so it is not kept for everyone. Shows TMDB failed for are not asked
 * again by the same holder.
 */
export interface ResolveTrace {
  failed?: boolean;
  tmdbDown?: Set<string>;
}

export type EpisodeNumbering = 'tmdb' | 'tvdb';

export async function videoIdFor(
  ids: Record<string, any>,
  season: number,
  episode: number,
  config: any = {},
  trace?: ResolveTrace,
  numbering: EpisodeNumbering = 'tmdb'
): Promise<{ metaId: string; videoId: string; mediaType: 'anime' | 'series' } | null> {
  ids = await canonicalIds(ids, 'series', config);
  // MDBList and PublicMetaDB number episodes the way TMDB does, unless they name TVDB's.
  if (ids.tmdb && numbering === 'tmdb') {
    const viaTmdb = await fromTmdbNumbering(ids, season, episode, config, trace);
    if (viaTmdb) return viaTmdb;
  }

  let tvdb = ids.tvdb;
  let imdb = ids.imdb;
  if (!tvdb && ids.tmdb) {
    tvdb = idMapper.getMappingByTmdbId(String(ids.tmdb), 'series')?.tvdb_id;
  }
  if (!tvdb && ids.imdb) {
    const found = idMapper.getMappingByImdbId(String(ids.imdb));
    if (idMapper.mappingIsType(found, 'series')) tvdb = found?.tvdb_id;
  }
  if ((!tvdb || !imdb) && ids.tmdb) {
    try {
      const idMappings: any = require('../id-mappings');
      const mapped = idMappings.getByTmdbId?.(String(ids.tmdb), 'series');
      if (!imdb && mapped?.imdbId) imdb = mapped.imdbId;
      if (!tvdb && mapped?.tvdbId) tvdb = mapped.tvdbId;
    } catch {
      // optional
    }
  }

  if (tvdb) {
    try {
      const anidb = await animeListMapper.resolveAnidbEpisodeFromTvdbEpisode(
        String(tvdb),
        season,
        episode
      );
      const mapping = anidb ? idMapper.getMappingByAnidbId(anidb.anidbId) : null;
      if (mapping?.kitsu_id) {
        return {
          metaId: `kitsu:${mapping.kitsu_id}`,
          videoId: `kitsu:${mapping.kitsu_id}:${anidb.anidbEpisode}`,
          mediaType: 'anime',
        };
      }
      const listed = idMapper.resolveKitsuEpisodeFromTvdbMapping(tvdb, season, episode);
      if (listed) {
        return { metaId: `kitsu:${listed.kitsuId}`, videoId: `kitsu:${listed.kitsuId}:${listed.episodeNumber}`, mediaType: 'anime' };
      }
    } catch (error: any) {
      logger.debug(`Anime resolution failed for tvdb ${tvdb} S${season}E${episode}: ${error?.message}`);
    }
  }

  const base = imdb || (tvdb ? `tvdb:${tvdb}` : ids.tmdb ? `tmdb:${ids.tmdb}` : null);
  if (!base) return null;

  return { metaId: base, videoId: `${base}:${season}:${episode}`, mediaType: 'series' };
}

async function mdblistRows(apiKey: string, config: any): Promise<ResumeRow[]> {
  const { makeRateLimitedMDBListRequest } = require('../../utils/mdbList');
  const response = await makeRateLimitedMDBListRequest(`https://api.mdblist.com/sync/playback?apikey=${apiKey}`, apiKey, 'MDBList resume');

  const rows: ResumeRow[] = [];
  for (const entry of Array.isArray(response?.data) ? response.data : []) {
    const progress = Number(entry?.progress);
    if (!Number.isFinite(progress) || progress <= 0) continue;

    const updatedAt = Date.parse(entry?.updated_at ?? entry?.paused_at ?? '') || 0;
    const runtimeMinutes = Number.isFinite(Number(entry?.runtime)) ? Number(entry.runtime) : null;

    if (entry?.movie) {
      const ids = await canonicalIds(entry.movie.ids ?? {}, 'movie', config);
      const base = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
      if (!base) continue;
      rows.push({ metaId: base, videoId: base, mediaType: 'movie', kind: 'movie', progress, runtimeMinutes, updatedAt });
      continue;
    }

    const show = entry?.show;
    const { mdblistWatchedRef } = require('../../utils/mdbList');
    const ref = show ? await mdblistWatchedRef({ ...entry?.episode, show }, config) : null;
    if (!ref) continue;
    const { season, episode } = ref;

    const resolved = await videoIdFor(ref.tvdb ? ref.ids : await canonicalIds(ref.ids, 'series', config), season, episode, config, undefined, ref.tvdb ? 'tvdb' : 'tmdb');
    if (!resolved) {
      logger.debug(`No id for a resume row: ${show.title} S${season}E${episode}`);
      continue;
    }

    rows.push({ ...resolved, kind: 'episode', progress, runtimeMinutes, updatedAt });
  }

  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Simkl answers with every id it knows and, for anime, the entry's own episode
// numbering beside the TVDB one, so a row names itself the way the meta does
// without going through the anidb pivot MDBList needs.
async function simklRows(tokenId: string, config: any): Promise<ResumeRow[]> {
  const { getSimklToken, fetchPlaybackSessions } = require('../../utils/simklUtils');

  const token = await getSimklToken(tokenId);
  if (!token?.access_token) return [];

  const rows: ResumeRow[] = [];
  for (const entry of await fetchPlaybackSessions(token.access_token)) {
    const progress = Number(entry?.progress);
    if (!Number.isFinite(progress) || progress <= 0) continue;

    const updatedAt = Date.parse(entry?.paused_at ?? '') || 0;
    const container = entry?.anime ?? entry?.show ?? entry?.movie;
    const isMovie = entry?.type === 'movie' || (!entry?.episode && entry?.movie);
    const ids = entry?.anime ? container?.ids ?? {} : await canonicalIds(container?.ids ?? {}, isMovie ? 'movie' : 'series', config);

    if (isMovie) {
      const base = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
      if (!base) continue;
      rows.push({ metaId: base, videoId: base, mediaType: 'movie', kind: 'movie', progress, runtimeMinutes: null, updatedAt });
      continue;
    }

    if (!entry?.episode) continue;

    if (entry.anime && ids.kitsu) {
      const number = Number(entry.episode.number);
      if (!Number.isFinite(number)) continue;
      rows.push({
        metaId: `kitsu:${ids.kitsu}`,
        videoId: `kitsu:${ids.kitsu}:${number}`,
        mediaType: 'anime',
        kind: 'episode',
        progress,
        runtimeMinutes: null,
        updatedAt,
      });
      continue;
    }

    const base = ids.imdb || (ids.tvdb ? `tvdb:${ids.tvdb}` : null);
    const season = Number(entry.episode.tvdb_season ?? entry.episode.season);
    const number = Number(entry.episode.tvdb_number ?? entry.episode.number);
    if (!base || !Number.isFinite(season) || !Number.isFinite(number)) continue;

    rows.push({
      metaId: base,
      videoId: `${base}:${season}:${number}`,
      mediaType: 'series',
      kind: 'episode',
      progress,
      runtimeMinutes: null,
      updatedAt,
    });
  }

  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function fromTmdbNumbering(
  ids: Record<string, any>,
  season: number,
  episode: number,
  config: any = {},
  trace?: ResolveTrace
): Promise<{ metaId: string; videoId: string; mediaType: 'anime' | 'series' } | null> {
  const tmdb = String(ids.tmdb);
  if (trace?.tmdbDown?.has(tmdb)) {
    trace.failed = true;
    return null;
  }
  try {
    if (idMapper.getMappingByTmdbId(tmdb, 'series')) {
      const kitsu = await idMapper.resolveKitsuEpisodeFromTmdb(Number(tmdb), season, episode, config);
      if (kitsu?.kitsuId) {
        return { metaId: `kitsu:${kitsu.kitsuId}`, videoId: `kitsu:${kitsu.kitsuId}:${kitsu.episodeNumber}`, mediaType: 'anime' };
      }
    }
    const position = await idMapper.tmdbEpisodePosition(Number(tmdb), season, episode, config);
    if (position === episode) return null;
    const base = ids.imdb || (ids.tvdb ? `tvdb:${ids.tvdb}` : `tmdb:${tmdb}`);
    return { metaId: base, videoId: `${base}:${season}:${position}`, mediaType: 'series' };
  } catch (error: any) {
    logger.debug(`TMDB numbering for ${tmdb} S${season}E${episode} failed: ${error?.message}`);
    if (trace) {
      trace.failed = true;
      (trace.tmdbDown ??= new Set()).add(tmdb);
    }
    return null;
  }
}

async function pmdbRows(apiKey: string, config: any): Promise<ResumeRow[]> {
  const { fetchResume } = require('../../utils/publicmetadbUtils');
  const rows: ResumeRow[] = [];
  for (const entry of await fetchResume(apiKey)) {
    const progress = Number(entry?.progress);
    if (!Number.isFinite(progress) || progress <= 0 || !entry?.tmdb_id) continue;
    const updatedAt = Date.parse(entry?.updated ?? entry?.created ?? '') || 0;
    const runtimeMinutes = Number(entry?.runtime_ms) > 0 ? Math.round(Number(entry.runtime_ms) / 60000) : null;

    if (entry.media_type === 'movie') {
      const base = await movieBase(entry.tmdb_id, config);
      rows.push({ metaId: base, videoId: base, mediaType: 'movie', kind: 'movie', progress, runtimeMinutes, updatedAt });
      continue;
    }
    const season = Number(entry?.season);
    const episode = Number(entry?.episode);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
    const resolved = await videoIdFor(await canonicalIds({ tmdb: entry.tmdb_id }, 'series', config), season, episode, config);
    if (resolved) rows.push({ ...resolved, kind: 'episode', progress, runtimeMinutes, updatedAt });
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A film's IMDb id for its TMDB id; the TMDB spelling when none is known. */
export async function movieBase(tmdbId: string | number, config: any = {}): Promise<string> {
  try {
    const { resolveAllIds } = require('../id-resolver');
    const ids = await resolveAllIds(`tmdb:${tmdbId}`, 'movie', config, {}, ['imdb']);
    if (ids?.imdbId) return String(ids.imdbId);
  } catch {}
  return `tmdb:${tmdbId}`;
}

async function rowsFrom(service: Capable, credential: string, config: any): Promise<ResumeRow[]> {
  if (service === 'mdblist') return mdblistRows(credential, config);
  if (service === 'simkl') return simklRows(credential, config);
  if (service === 'publicmetadb') return pmdbRows(credential, config);

  logger.debug(`Resume source ${service} has no reader yet`);
  return [];
}

// No id mapping: the video id was recorded in the space the client played it in.
async function ownRows(userUUID: string, profile: string): Promise<ResumeRow[]> {
  const database: any = require('../database');
  const { parseStremioId } = require('./ids');
  const limit = envInt('JELLYFIN_RESUME_OWN_LIMIT', 100, 1);

  let records: any[] = [];
  try {
    records = await database.listResume(userUUID, limit, profile);
  } catch (error: any) {
    logger.debug(`Own resume rows unavailable: ${error?.message || error}`);
    return [];
  }

  const rows: ResumeRow[] = [];
  for (const r of records) {
    const videoId = String(r.video_id);
    const runtimeMs = Number(r.runtime_ms) || 0;
    const positionMs = Number(r.position_ms) || 0;
    if (runtimeMs <= 0 || positionMs <= 0 || belowResumeFloor(positionMs, runtimeMs)) continue;

    const parsed = parseStremioId(videoId);
    const isEpisode = Boolean(parsed && parsed.episode !== null && parsed.episode !== undefined);
    const mediaType: ResumeRow['mediaType'] = !isEpisode
      ? 'movie'
      : parsed.idType === 'kitsu' || parsed.idType === 'mal' || parsed.idType === 'anilist' ? 'anime' : 'series';

    rows.push({
      metaId: isEpisode ? parsed.base : videoId,
      videoId,
      mediaType,
      kind: isEpisode ? 'episode' : 'movie',
      progress: Math.min(100, (positionMs / runtimeMs) * 100),
      runtimeMinutes: Math.round(runtimeMs / 60000),
      updatedAt: Number(r.last_played_at) || Number(r.updated_at) || 0,
      writtenAt: Number(r.updated_at) || 0,
    });
  }

  // The earliest write of a batch is the spelling the client played under.
  const { dedupeByAlias } = require('./aliases');
  const deduped: ResumeRow[] = await dedupeByAlias([...rows].sort((a, b) => (a.writtenAt ?? 0) - (b.writtenAt ?? 0)));
  return deduped.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function resumeSnapshot(userUUID: string, config: any): Promise<ResumeRow[]> {
  const { profileKey, readsTrackers } = require('./profiles');
  const database: any = require('../database');
  const profile = profileKey(config);

  const tracker = readsTrackers(config) ? await trackerSnapshot(userUUID, config) : [];
  const own = await ownRows(userUUID, profile);
  let known = new Map<string, any>();
  try {
    const { getPlaystatesAcross } = require('./aliases');
    known = await getPlaystatesAcross(userUUID, tracker.map((r) => r.videoId), profile);
  } catch (error: any) {
    logger.debug(`Own playstate rows unavailable: ${error?.message || error}`);
  }
  const overrides = tracker.filter((row) => known.has(row.videoId) && trackerPositionWins(row, known.get(row.videoId)));
  return oneRowPerTitle([...overrides, ...own, ...tracker.filter((r) => !known.has(r.videoId))], config);
}

// A play is written under every id it is known by; one row per resolved title.
export async function oneRowPerTitle(candidates: ResumeRow[], config: any): Promise<ResumeRow[]> {
  const { titleIdentity } = require('./canonicalIds');
  const { videoIdAliases } = require('./aliases');
  const taken = new Set<string>();
  const rows: ResumeRow[] = [];
  for (const row of candidates) {
    const spellings = [row.videoId, await titleIdentity(row.videoId, config), ...(await videoIdAliases(row.videoId))];
    if (spellings.some((spelling) => taken.has(spelling))) continue;
    for (const spelling of spellings) taken.add(spelling);
    rows.push(row);
  }
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A tracker position newer than the table's row, and not this server's own echoed back, replaces it. */
export function trackerPositionWins(row: ResumeRow, held: any): boolean {
  if (!held) return true;
  if (row.updatedAt <= (Number(held.updated_at) || 0)) return false;
  const runtimeMs = Number(held.runtime_ms) || 0;
  const heldProgress = runtimeMs > 0 ? ((Number(held.position_ms) || 0) / runtimeMs) * 100 : 0;
  return Math.abs(row.progress - heldProgress) > envInt('JELLYFIN_RESUME_ECHO_PERCENT', 2, 0);
}

const positionMemo = new LRUCache<string, Map<string, ResumeRow>>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_RESUME_TTL', 60, 1) * 1000,
});

/** Tracker paused positions under every spelling of their video. */
export async function trackerPositions(userUUID: string, config: any): Promise<Map<string, ResumeRow>> {
  const { profileKey, readsTrackers } = require('./profiles');
  if (!readsTrackers(config)) return new Map();
  const key = `${userUUID}:${profileKey(config)}:${resumeSourcesFor(config).join(',')}:${generationOf(userUUID)}`;
  const held = positionMemo.get(key);
  if (held) return held;
  const { videoIdAliases } = require('./aliases');
  const { titleIdentity } = require('./canonicalIds');
  const out = new Map<string, ResumeRow>();
  for (const row of await trackerSnapshot(userUUID, config)) {
    for (const spelling of [row.videoId, ...(await videoIdAliases(row.videoId)), await titleIdentity(row.videoId, config)]) {
      if (!out.has(spelling)) out.set(spelling, row);
    }
  }
  positionMemo.set(key, out);
  return out;
}

// Each connected service is read: a title paused through one app is only on
// that app's tracker. The same video on two of them takes the newer position.
export async function trackerSnapshot(userUUID: string, config: any): Promise<ResumeRow[]> {
  const parts = await Promise.all(
    resumeSourcesFor(config).map(async (service) => {
      const part = await serviceSnapshot(userUUID, config, service);
      return { ok: part.ok, rows: part.rows.map((row) => ({ ...row, service })) };
    })
  );
  const merged = new Map<string, ResumeRow>();
  for (const row of parts.flatMap((part) => part.rows)) {
    const held = merged.get(row.videoId);
    if (!held || row.updatedAt > held.updatedAt) merged.set(row.videoId, row);
  }
  const { dedupeByAlias } = require('./aliases');
  const rows: ResumeRow[] = await dedupeByAlias([...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt));
  if (parts.length && parts.every((part) => part.ok)) await followTrackerClears(userUUID, config, rows);
  return rows.filter((row) => !belowTrackerFloor(row.progress));
}

async function serviceSnapshot(userUUID: string, config: any, service: Capable): Promise<{ rows: ResumeRow[]; ok: boolean }> {
  const credential = credentialFor(config, service);
  if (!credential) return { rows: [], ok: false };

  const key = `${userUUID}:${service}:${createHash('sha256').update(String(credential)).digest('hex').slice(0, 16)}`;
  const held = snapshots.get(key);
  // Read again only once the tracker reports playback moved; one that reports nothing is read on a timer.
  if (held && Date.now() - held.at < envInt('JELLYFIN_RESUME_TTL', 60, 1) * 1000) return held;
  const fingerprint = await playbackFingerprint(service, credential, config);
  if (held && fingerprint && fingerprint === held.fingerprint && (service !== 'mdblist' || Date.now() - held.at < resumeMaxAgeMs())) return held;

  const generation = generationOf(userUUID);
  const flightKey = `${generation}:${key}`;
  const running = inFlight.get(flightKey);
  if (running) return running;

  const started = (async () => {
    try {
      const rows = await rowsFrom(service, credential, config);
      const read = { rows, fingerprint, at: Date.now(), ok: true };
      if (generationOf(userUUID) === generation) snapshots.set(key, read);
      logger.debug(`Resume snapshot for ${userUUID} from ${service}: ${rows.length} rows`);
      return read;
    } catch (error: any) {
      const failed = { rows: [], fingerprint: null, at: Date.now(), ok: false };
      if (generationOf(userUUID) === generation) snapshots.set(key, failed);
      logger.warn(`Resume snapshot from ${service} failed: ${error?.message || error}; not read again for ${envInt('JELLYFIN_RESUME_TTL', 60, 1)}s`);
      return failed;
    } finally {
      if (inFlight.get(flightKey) === started) inFlight.delete(flightKey);
    }
  })();

  inFlight.set(flightKey, started);
  return started;
}

// A finished title can hold a resume point at the same time, which is what a
// rewatch is, so Played comes from the watch history rather than being assumed
// false because the row is resumable.
/** Dropped when this server is itself the thing that changed the state. */
const clearsFollowed = new LRUCache<string, string>({ max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1) });
const clearsInFlight = new Map<string, Promise<void>>();

async function followTrackerClears(userUUID: string, config: any, rows: ResumeRow[]): Promise<void> {
  const { profileKey } = require('./profiles');
  const profile = profileKey(config);
  const sources = resumeSourcesFor(config).map((service) => `${service}:${credentialFor(config, service)}`).join('|');
  const key = `${userUUID}:${profile}:${createHash('sha256').update(sources).digest('hex').slice(0, 16)}`;
  const ids = [...new Set(rows.map((row) => row.videoId))].sort();
  const digest = createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16);
  if (clearsFollowed.get(key) === digest) return;

  const running = clearsInFlight.get(key);
  if (running) return running;
  const started = (async () => {
    try {
      await reconcileClears(userUUID, profile, config, key, ids, digest);
      clearsFollowed.set(key, digest);
    } catch (error: any) {
      logger.debug(`Tracker resume clears not followed for ${userUUID}: ${error?.message || error}`);
    } finally {
      clearsInFlight.delete(key);
    }
  })();
  clearsInFlight.set(key, started);
  return started;
}

async function reconcileClears(userUUID: string, profile: string, config: any, key: string, ids: string[], digest: string): Promise<void> {
  const { readGlobalCache, writeGlobalCache } = require('../getCache');
  const storeKey = `jellyfin_tracker_paused_v1:${key}`;
  const held = await readGlobalCache(storeKey);
  if (held?.digest === digest) return;

  if (Array.isArray(held?.ids)) {
    const cleared = await clearDropped(userUUID, profile, config, held.ids, Number(held.seenAt) || 0, new Set(ids));
    if (cleared) {
      forgetShelves(userUUID);
      logger.info(`${cleared} resume point(s) the tracker no longer holds removed from the playstate of ${userUUID}`);
    }
  }
  await writeGlobalCache(storeKey, { digest, seenAt: Date.now(), ids }, envInt('JELLYFIN_TRACKER_SEEN_DAYS', 30, 1) * 24 * 60 * 60);
}

async function clearDropped(userUUID: string, profile: string, config: any, before: string[], seenAt: number, current: Set<string>): Promise<number> {
  const gone = before.filter((id) => !current.has(id));
  if (!gone.length) return 0;
  if (gone.length > Math.max(10, before.length / 2)) {
    logger.warn(`Tracker resume list for ${userUUID} lost ${gone.length} of ${before.length} titles at once; not treated as cleared`);
    return 0;
  }

  const database: any = require('../database');
  const { parseStremioId } = require('./ids');
  const { videoIdAliases } = require('./aliases');
  const { movieSpellings } = require('./watched');
  let cleared = 0;
  for (const id of gone) {
    const parsed = parseStremioId(id);
    const isEpisode = Boolean(parsed && parsed.episode !== null && parsed.episode !== undefined);
    const spellings = [id, ...(isEpisode ? await videoIdAliases(id) : await movieSpellings(id, config))];
    if (spellings.some((spelling) => current.has(spelling))) continue;

    const rows = [...(await database.getPlaystates(userUUID, spellings, profile)).values()].filter((row: any) => Number(row.position_ms) > 0);
    if (!rows.length || rows.some((row: any) => Number(row.last_played_at) > seenAt)) continue;

    for (const row of rows) await database.upsertPlaystate(userUUID, row.video_id, { positionMs: 0 }, profile);
    cleared += 1;
  }
  return cleared;
}

function forgetShelves(userUUID: string): void {
  for (const cache of [positionMemo, nextUpPages, lastNextUp] as LRUCache<string, any>[]) {
    for (const key of [...cache.keys()]) {
      if (String(key).startsWith(`${userUUID}:`)) cache.delete(key);
    }
  }
}

export function invalidateResume(userUUID: string): void {
  generations.set(userUUID, generationOf(userUUID) + 1);
  for (const key of [...snapshots.keys()]) {
    if (String(key).startsWith(`${userUUID}:`)) snapshots.delete(key);
  }
  for (const cache of [nextUpPages, lastNextUp]) {
    for (const key of [...cache.keys()]) {
      if (String(key).startsWith(`${userUUID}:`)) cache.delete(key);
    }
  }
}

/** Drops a user's held Upcoming and calendar lists. */
export function invalidateDatedShelves(userUUID: string): void {
  for (const key of [...nextUpPages.keys()]) {
    if (String(key).startsWith(`${userUUID}:`) && /:(upcoming|calendar):/.test(String(key))) nextUpPages.delete(key);
  }
}

const nextUpPages = new LRUCache<string, any[]>({
  max: envInt('JELLYFIN_NEXTUP_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_NEXTUP_TTL', 900, 1) * 1000,
});
const nextUpInFlight = new Map<string, Promise<any[]>>();

// What a shelf last showed, answered while a slower rebuild finishes behind it.
const lastNextUp = new LRUCache<string, any[]>({
  max: envInt('JELLYFIN_NEXTUP_CACHE_MAX', 500, 1),
  ttl: 24 * 60 * 60 * 1000,
});

export interface NextUpDeadline {
  ms: number;
  shelfKey: string;
}

/** One Next Up list per shelf shape, shared by concurrent asks and kept briefly; a play drops it. */
export async function memoNextUp(
  userUUID: string,
  key: string,
  build: () => Promise<any[]>,
  validUntil?: (result: any[]) => number | null,
  deadline?: NextUpDeadline
): Promise<any[]> {
  const held = nextUpPages.get(key);
  if (held) return held;
  const generation = generationOf(userUUID);
  const flightKey = `${generation}:${key}`;
  let work = nextUpInFlight.get(flightKey);
  if (!work) {
    const started: Promise<any[]> = build()
      .then((result) => {
        if (generationOf(userUUID) === generation) {
          const until = validUntil?.(result);
          const left = until ? until - Date.now() : null;
          nextUpPages.set(key, result, left && left > 0 && left < nextUpPages.ttl! ? { ttl: left } : undefined);
          if (deadline) lastNextUp.set(deadline.shelfKey, result);
        }
        return result;
      })
      .finally(() => {
        if (nextUpInFlight.get(flightKey) === started) nextUpInFlight.delete(flightKey);
      });
    nextUpInFlight.set(flightKey, started);
    work = started;
  }
  if (!deadline) return work;

  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadline.ms);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([work, late]);
    if (result) return result;
    const previous = lastNextUp.get(deadline.shelfKey);
    logger.debug(`Next Up for ${userUUID} still building after ${deadline.ms}ms; answering with ${previous ? `the last ${previous.length}` : 'nothing'} meanwhile`);
    return previous ?? [];
  } finally {
    clearTimeout(timer);
  }
}

export function resumeUserData(
  id: string,
  row: ResumeRow,
  runTimeTicks: number | null,
  played = false
): any {
  const fromItem = runTimeTicks && runTimeTicks > 0 ? runTimeTicks : null;
  const fromRow = row.runtimeMinutes ? row.runtimeMinutes * 60 * 1000 * 10000 : null;
  const total = fromItem ?? fromRow ?? 0;

  return {
    PlaybackPositionTicks: Math.round((total * row.progress) / 100),
    PlayedPercentage: row.progress,
    PlayCount: played ? 1 : 0,
    IsFavorite: false,
    Played: played,
    ...(row.updatedAt > 0 ? { LastPlayedDate: new Date(row.updatedAt).toISOString() } : {}),
    Key: id,
    ItemId: id,
  };
}
