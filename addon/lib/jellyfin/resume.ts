import consola from 'consola';
import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';
import { type Capable, credentialFor, sourceFor } from './trackerSource';

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
}

const snapshots = new LRUCache<string, ResumeRow[]>({
  max: envInt('JELLYFIN_RESUME_CACHE_MAX', 500, 1),
  ttl: envInt('JELLYFIN_RESUME_TTL', 60, 1) * 1000,
});

const inFlight = new Map<string, Promise<ResumeRow[]>>();

/**
 * A tracker names an episode in its own space, which for anime is rarely the
 * one the meta publishes: a row stored as TVDB S3E11 is `kitsu:49002:11` here.
 * The anidb pivot is what the meta path itself uses, so ids come back matching
 * the items already in the library rather than a second, parallel identity.
 */
export async function videoIdFor(
  ids: Record<string, any>,
  season: number,
  episode: number
): Promise<{ metaId: string; videoId: string; mediaType: 'anime' | 'series' } | null> {
  let tvdb = ids.tvdb;
  if (!tvdb && ids.tmdb) {
    tvdb = idMapper.getMappingByTmdbId(String(ids.tmdb), 'series')?.tvdb_id;
  }
  if (!tvdb && ids.imdb) {
    tvdb = idMapper.getMappingByImdbId(String(ids.imdb))?.tvdb_id;
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
    } catch (error: any) {
      logger.debug(`Anime resolution failed for tvdb ${tvdb} S${season}E${episode}: ${error?.message}`);
    }
  }

  const base = ids.imdb || (tvdb ? `tvdb:${tvdb}` : ids.tmdb ? `tmdb:${ids.tmdb}` : null);
  if (!base) return null;

  return { metaId: base, videoId: `${base}:${season}:${episode}`, mediaType: 'series' };
}

async function mdblistRows(apiKey: string): Promise<ResumeRow[]> {
  const { httpGet } = require('../../utils/httpClient');
  const response = await httpGet(
    `https://api.mdblist.com/sync/playback?apikey=${apiKey}`,
    { timeout: envInt('JELLYFIN_RESUME_TIMEOUT_MS', 10000, 1000) }
  );

  const rows: ResumeRow[] = [];
  for (const entry of Array.isArray(response?.data) ? response.data : []) {
    const progress = Number(entry?.progress);
    if (!Number.isFinite(progress) || progress <= 0) continue;

    const updatedAt = Date.parse(entry?.updated_at ?? entry?.paused_at ?? '') || 0;
    const runtimeMinutes = Number.isFinite(Number(entry?.runtime)) ? Number(entry.runtime) : null;

    if (entry?.movie) {
      const ids = entry.movie.ids ?? {};
      const base = ids.imdb || (ids.tmdb ? `tmdb:${ids.tmdb}` : null);
      if (!base) continue;
      rows.push({ metaId: base, videoId: base, mediaType: 'movie', kind: 'movie', progress, runtimeMinutes, updatedAt });
      continue;
    }

    const show = entry?.show;
    const season = Number(entry?.episode?.season);
    const episode = Number(entry?.episode?.number);
    if (!show || !Number.isFinite(season) || !Number.isFinite(episode)) continue;

    const resolved = await videoIdFor(show.ids ?? {}, season, episode);
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
async function simklRows(tokenId: string): Promise<ResumeRow[]> {
  const { getSimklToken, fetchPlaybackSessions } = require('../../utils/simklUtils');

  const token = await getSimklToken(tokenId);
  if (!token?.access_token) return [];

  const rows: ResumeRow[] = [];
  for (const entry of await fetchPlaybackSessions(token.access_token)) {
    const progress = Number(entry?.progress);
    if (!Number.isFinite(progress) || progress <= 0) continue;

    const updatedAt = Date.parse(entry?.paused_at ?? '') || 0;
    const container = entry?.anime ?? entry?.show ?? entry?.movie;
    const ids = container?.ids ?? {};

    if (entry?.type === 'movie' || (!entry?.episode && entry?.movie)) {
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

async function rowsFrom(service: Capable, credential: string): Promise<ResumeRow[]> {
  if (service === 'mdblist') return mdblistRows(credential);
  if (service === 'simkl') return simklRows(credential);

  // Trakt and PublicMetaDB hold positions too, but reading them back is not
  // wired yet, so their rows are absent rather than wrong.
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
    if (runtimeMs <= 0 || positionMs <= 0) continue;

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
    });
  }
  return rows;
}

export async function resumeSnapshot(userUUID: string, config: any): Promise<ResumeRow[]> {
  const { profileKey, readsTrackers } = require('./profiles');
  const database: any = require('../database');
  const profile = profileKey(config);

  // A tracker only adds what this server never saw, such as another device. A
  // video the table knows at all is the table's call, finished or not.
  const own = await ownRows(userUUID, profile);
  const tracker = readsTrackers(config) ? await trackerSnapshot(userUUID, config) : [];
  let known = new Map<string, any>();
  try {
    known = await database.getPlaystates(userUUID, tracker.map((r) => r.videoId), profile);
  } catch (error: any) {
    logger.debug(`Own playstate rows unavailable: ${error?.message || error}`);
  }
  return [...own, ...tracker.filter((r) => !known.has(r.videoId))].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function trackerSnapshot(userUUID: string, config: any): Promise<ResumeRow[]> {
  const service = sourceFor(config);
  if (!service) return [];

  const credential = credentialFor(config, service);
  if (!credential) return [];

  const key = `${userUUID}:${service}`;
  const cached = snapshots.get(key);
  if (cached) return cached;

  const running = inFlight.get(key);
  if (running) return running;

  const started = (async () => {
    try {
      const rows = await rowsFrom(service, credential);
      snapshots.set(key, rows);
      logger.debug(`Resume snapshot for ${userUUID} from ${service}: ${rows.length} rows`);
      return rows;
    } catch (error: any) {
      logger.warn(`Resume snapshot from ${service} failed: ${error?.message || error}`);
      return [];
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, started);
  return started;
}

// A finished title can hold a resume point at the same time, which is what a
// rewatch is, so Played comes from the watch history rather than being assumed
// false because the row is resumable.
/** Dropped when this server is itself the thing that changed the state. */
export function invalidateResume(userUUID: string): void {
  for (const key of [...snapshots.keys()]) {
    if (String(key).startsWith(`${userUUID}:`)) snapshots.delete(key);
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
    UnplayedItemCount: 0,
    Key: id,
    ItemId: id,
  };
}
