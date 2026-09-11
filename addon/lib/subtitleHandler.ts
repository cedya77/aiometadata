const consola: any = require('consola');
const idMapper: any = require('./id-mapper');
const { resolveTmdbEpisodeFromKitsu }: any = require('./id-mapper');
const { resolveTvdbEpisodeFromAnidbEpisode, resolveAnidbEpisodeFromTvdbEpisode }: any = require('./anime-list-mapper');
const anilistTracker: any = require('./anilistTracker');
const malTracker: any = require('./malTracker');
const simklUtils: any = require('../utils/simklUtils');
import {
  isWatchTrackingServiceEnabled,
  normalizeWatchTrackingMediaType,
  shouldTrackServiceMediaType,
} from './watchTracking';

const logger: any = consola.withTag('SubtitleHandler');

interface ParsedMediaId {
  type: 'movie' | 'series';
  provider: string;
  id: string;
  season?: number;
  episode?: number;
}

interface ResolvedSeriesIds {
  ids: Record<string, any>;
  fallbackData?: any;
  season: number;
  episode: number;
}

function parseMediaId(id: any): ParsedMediaId | null {
  if (!id || typeof id !== 'string') {
    logger.debug(`[Watch Tracking] Invalid media ID format - id is ${id === null ? 'null' : id === undefined ? 'undefined' : 'not a string'}, type: ${typeof id}`);
    return null;
  }

  const cleanId = id.trim();
  if (cleanId.length === 0 || cleanId.length > 150) {
    logger.debug(`[Watch Tracking] Invalid media ID format - empty or exceeds maximum length (${cleanId.length})`);
    return null;
  }

  const parts = cleanId.split(':').map((part: string) => part.trim()).filter(Boolean);

  if (parts.length === 0) {
    logger.debug('[Watch Tracking] Invalid media ID format - no parts after splitting');
    return null;
  }

  const [prefix, ...rest] = parts;

  const isImdb = prefix.startsWith('tt');
  const imdbMatch = isImdb ? /^tt\d+$/.test(prefix) : false;

  const isPrefixedId = !isImdb && ['tmdb', 'tvdb', 'trakt', 'kitsu'].includes(prefix);

  if (!isPrefixedId && !imdbMatch) {
    logger.debug(`[Watch Tracking] Unsupported media prefix: ${prefix}`);
    return null;
  }

  const provider = isPrefixedId ? prefix : 'imdb';

  if (provider === 'imdb') {
    if (rest.length === 0) {
      return { type: 'movie', provider, id: prefix };
    }

    if (rest.length === 2) {
      const [seasonStr, episodeStr] = rest;
      const season = parseInt(seasonStr, 10);
      const episode = parseInt(episodeStr, 10);
      if (Number.isNaN(season) || season < 1 || season > 999) {
        logger.debug(`[Watch Tracking] Invalid season value in IMDb ID: season=${seasonStr}`);
        return null;
      }
      if (Number.isNaN(episode) || episode < 1 || episode > 9999) {
        logger.debug(`[Watch Tracking] Invalid episode value in IMDb ID: episode=${episodeStr}`);
        return null;
      }
      return { type: 'series', provider, id: prefix, season, episode };
    }

    logger.debug(`[Watch Tracking] Invalid IMDb media ID structure: ${cleanId}`);
    return null;
  }

  if (rest.length === 0) {
    logger.debug(`[Watch Tracking] Missing identifier for provider ${provider}`);
    return null;
  }

  const numericId = rest[0];
  if (!numericId || !/^\d+$/.test(numericId)) {
    logger.debug(`[Watch Tracking] Invalid numeric identifier for provider ${provider}: ${numericId}`);
    return null;
  }

  if (rest.length === 1) {
    if (provider === 'tvdb') {
      logger.debug('[Watch Tracking] TVDB identifiers must include season and episode numbers');
      return null;
    }

    return { type: 'movie', provider, id: numericId };
  }

  if (rest.length === 2 && provider === 'kitsu') {
    const [episodeStr] = rest.slice(1);
    const episode = parseInt(episodeStr, 10);
    if (Number.isNaN(episode) || episode < 1 || episode > 9999) {
      logger.debug(`[Watch Tracking] Invalid episode value for Kitsu provider: ${episodeStr}`);
      return null;
    }
    const season = 1;
    return { type: 'series', provider, id: numericId, season, episode };
  }

  if (rest.length === 3) {
    if (!['tmdb', 'tvdb', 'trakt', 'kitsu'].includes(provider)) {
      logger.debug(`[Watch Tracking] Provider ${provider} does not support season/episode structure`);
      return null;
    }

    const [seasonStr, episodeStr] = rest.slice(1);
    const season = parseInt(seasonStr, 10);
    const episode = parseInt(episodeStr, 10);
    if (Number.isNaN(season) || season < 1 || season > 999) {
      logger.debug(`[Watch Tracking] Invalid season value for provider ${provider}: ${seasonStr}`);
      return null;
    }
    if (Number.isNaN(episode) || episode < 1 || episode > 9999) {
      logger.debug(`[Watch Tracking] Invalid episode value for provider ${provider}: ${episodeStr}`);
      return null;
    }

    return { type: 'series', provider, id: numericId, season, episode };
  }

  logger.debug(`[Watch Tracking] Unsupported media ID format for provider ${provider}: ${cleanId}`);
  return null;
}

function shouldTrackMdblistWatch(config: any): boolean {
  if (!config?.apiKeys?.mdblist) {
    logger.debug('[Watch Tracking] Skipped - No MDBList API key configured');
    return false;
  }

  if (config.mdblistWatchTracking === false) {
    logger.debug('[Watch Tracking] Skipped - Feature disabled in user config');
    return false;
  }

  const enabled = config.mdblistWatchTracking !== false;
  logger.debug(`[Watch Tracking] Enabled - API key present, flag=${enabled}`);
  return enabled;
}

function shouldTrackAniList(config: any): boolean {
  return isWatchTrackingServiceEnabled(config, 'anilist');
}

function handleSubtitleRequest(type: string, id: string, config: any, userUUID: string): { subtitles: any[] } {
  try {
    logger.debug(`[Watch Tracking] Subtitle request received, type: ${type}, id: ${id}`);

    // A Jellyfin client asks for subtitles when an item is opened, not when it
    // is played, so this trigger cannot mean "watching" for anyone whose
    // playback is reported through the playback resource instead.
    if (config?.playbackReporting) {
      logger.debug(`[Watch Tracking] Skipped subtitle check-in, playback is reported by the client, id: ${id}`);
      return { subtitles: [] };
    }

    const parsedId = parseMediaId(id);
    if (!parsedId) {
      logger.warn(`[Watch Tracking] Failed to parse media ID, id: ${id}, type: ${type}`);
      return { subtitles: [] };
    }

    const mediaType = normalizeWatchTrackingMediaType(type, parsedId.type);
    if (!mediaType) {
      logger.warn(
        `[Watch Tracking] Skipped ambiguous playback event - route type ${type} conflicts with parsed type ${parsedId.type}, id: ${id}`,
      );
      return { subtitles: [] };
    }

    if (shouldTrackServiceMediaType(config, 'mdblist', mediaType)) {
      trackMdblistWatchStatus(parsedId, config).catch((error: any) => {
        logger.error(`[Mdblist Watch Tracking] MDBList tracking failed for ${id}: ${error.message}`, {
          stack: error.stack,
          parsedId: parsedId
        });
      });
    }

    if (shouldTrackServiceMediaType(config, 'anilist', mediaType)) {
      anilistTracker.trackAnimeProgress(parsedId, config, userUUID).catch((error: any) => {
        logger.error(`[Watch Tracking] AniList tracking failed for ${id}: ${error.message}`, {
          stack: error.stack,
          parsedId: parsedId
        });
      });
    }

    if (shouldTrackServiceMediaType(config, 'mal', mediaType)) {
      malTracker.trackAnimeProgress(parsedId, config, userUUID).catch((error: any) => {
        logger.error(`[Watch Tracking] MAL tracking failed for ${id}: ${error.message}`, {
          stack: error.stack,
          parsedId: parsedId
        });
      });
    }

    if (shouldTrackServiceMediaType(config, 'simkl', mediaType)) {
      checkinSimkl(parsedId, config).catch((error: any) => {
        logger.error(`[Watch Tracking] Simkl tracking failed for ${id}: ${error.message}`, {
          stack: error.stack,
          parsedId: parsedId
        });
      });
    }

    if (shouldTrackServiceMediaType(config, 'trakt', mediaType)) {
      checkinTrakt(parsedId, config).catch((error: any) => {
        logger.error(`[Watch Tracking] Trakt tracking failed for ${id}: ${error.message}`, {
          stack: error.stack,
          parsedId: parsedId
        });
      });
    }

    if (shouldTrackServiceMediaType(config, 'publicmetadb', mediaType)) {
      checkinPublicMetaDB(parsedId, config).catch((error: any) => {
        logger.error(`[Watch Tracking] PublicMetaDB tracking failed for ${id}: ${error.message}`, {
          stack: error.stack,
          parsedId: parsedId
        });
      });
    }

    return { subtitles: [] };

  } catch (error: any) {
    logger.error(`[Watch Tracking] Subtitle handler error, type: ${type}, id: ${id}, error: ${error.message}`, {
      stack: error.stack
    });
    return { subtitles: [] };
  }
}

function buildIdSummary(ids: Record<string, any>): string {
  return Object.entries(ids || {})
    .map(([key, value]) => `${key}:${value}`)
    .join(', ');
}

function normalizeIdsForMovie(parsedId: ParsedMediaId): Record<string, any> | null {
  switch (parsedId.provider) {
    case 'imdb':
      return { imdb: parsedId.id };
    case 'tmdb':
      return { tmdb: parseInt(parsedId.id, 10) };
    case 'trakt':
      return { trakt: parseInt(parsedId.id, 10) };
    case 'kitsu': {
      const kitsuId = parseInt(parsedId.id, 10);
      if (Number.isNaN(kitsuId) || kitsuId <= 0) {
        logger.debug(`[Watch Tracking] Invalid Kitsu movie identifier: ${parsedId.id}`);
        return null;
      }

      const mapping = idMapper.getMappingByKitsuId(kitsuId);
      const malId = mapping?.mal_id;
      if (malId) {
        const traktMovie = idMapper.getTraktAnimeMovieByMalId(malId);
        const imdbId = traktMovie?.externals?.imdb;
        if (imdbId) {
          return { imdb: imdbId };
        }
      }

      logger.debug(`[Watch Tracking] Falling back to Kitsu ID for movie ${parsedId.id}`);
      return { kitsu: kitsuId };
    }
    default:
      logger.debug(`[Watch Tracking] Unsupported movie provider: ${parsedId.provider}`);
      return null;
  }
}

async function resolveSeriesIds(parsedId: ParsedMediaId, config: any = {}, isSimkl: boolean = false): Promise<ResolvedSeriesIds | null> {
  switch (parsedId.provider) {
    case 'imdb': {
      const animeMapping = idMapper.getMappingByImdbId(parsedId.id);
      if (animeMapping?.tvdb_id && !isSimkl) {
        try {
          const anidbInfo = await resolveAnidbEpisodeFromTvdbEpisode(
            animeMapping.tvdb_id, parsedId.season || 1, parsedId.episode
          );
          if (anidbInfo) {
            const anidbMapping = idMapper.getMappingByAnidbId(anidbInfo.anidbId);
            if (anidbMapping?.anilist_id) {
              const anilistMapping = idMapper.getMappingByAnilistId(anidbMapping.anilist_id);
              if (anilistMapping?.kitsu_id) {
                const resolved = await resolveTmdbEpisodeFromKitsu(
                  anilistMapping.kitsu_id, anidbInfo.anidbEpisode, config
                );
                if (resolved) {
                  logger.debug(
                    `[Watch Tracking] Resolved anime IMDB ${parsedId.id} → TVDB ${animeMapping.tvdb_id} → AniDB ${anidbInfo.anidbId} → AniList ${anidbMapping.anilist_id} → Kitsu ${anilistMapping.kitsu_id} → TMDB ${resolved.tmdbId} S${resolved.seasonNumber}E${resolved.episodeNumber}`
                  );
                  return {
                    ids: { tmdb: resolved.tmdbId },
                    season: resolved.seasonNumber,
                    episode: resolved.episodeNumber
                  };
                }
              }
            }
          }
        } catch (error: any) {
          logger.debug(`[Watch Tracking] Anime IMDB resolution failed for ${parsedId.id}: ${error.message}`);
        }
      }
      return {
        ids: { imdb: parsedId.id },
        season: parsedId.season!,
        episode: parsedId.episode!
      };
    }
    case 'tvdb':
      return {
        ids: { tvdb: parseInt(parsedId.id, 10) },
        season: parsedId.season!,
        episode: parsedId.episode!
      };
    case 'tmdb': {
      const mapping = idMapper.getMappingByTmdbId(parsedId.id, 'series');
      if (!mapping) {
        logger.debug(`[Watch Tracking] No mapping found for TMDB series ${parsedId.id}`);
        return null;
      }
      const ids: Record<string, any> = {};
      if (mapping.imdb_id) ids.imdb = mapping.imdb_id;
      if (mapping.tvdb_id) ids.tvdb = parseInt(mapping.tvdb_id, 10);

      if (Object.keys(ids).length === 0) {
        logger.debug(`[Watch Tracking] TMDB ${parsedId.id} mapping lacks IMDb/TVDB identifiers`);
        return null;
      }

      return { ids, season: parsedId.season!, episode: parsedId.episode! };
    }
    case 'kitsu': {
      let resolved: any;
      let fallback: any;
      if (!isSimkl) {
        resolved = await resolveTmdbEpisodeFromKitsu(
          parseInt(parsedId.id, 10),
          parseInt(String(parsedId.episode), 10),
          config
        );

        if (!resolved) {
          logger.debug(`[Watch Tracking] Could not resolve Kitsu → TMDB for Kitsu series ${parsedId.id}`);
          return null;
        }
      } else {
        const mappings = idMapper.getMappingByKitsuId(parseInt(parsedId.id, 10));
        const malId = mappings?.mal_id || null;
        const anidbId = mappings.anidb_id;
        let tvdbInfo: any;
        if (anidbId) {
          tvdbInfo = resolveTvdbEpisodeFromAnidbEpisode(anidbId, 1, parseInt(String(parsedId.episode), 10));
        }
        if (tvdbInfo) {
          logger.debug(`[tvdb anilist] tvdb anilist mapping: ${JSON.stringify(tvdbInfo)} `);
          resolved = {
            tvdbId: tvdbInfo.tvdbId,
            seasonNumber: tvdbInfo.tvdbSeason,
            episodeNumber: tvdbInfo.tvdbEpisode
          };
        }
        if (malId) {
          fallback = {
            malId: malId,
            seasonNumber: 1,
            episodeNumber: parseInt(String(parsedId.episode), 10)
          };
        }
      }

      return {
        ids: { tmdb: resolved.tmdbId, mal: resolved.malId, tvdb: resolved.tvdbId },
        fallbackData: fallback?.malId ? { ids: { mal: fallback.malId }, season: 1, episode: fallback.episodeNumber } : null,
        season: resolved.seasonNumber,
        episode: resolved.episodeNumber
      };
    }
    default:
      logger.debug(`[Watch Tracking] Unsupported series provider: ${parsedId.provider}`);
      return null;
  }
}

/**
 * `options` selects the MDBList call, matching checkinSimkl. Left out this stays
 * the check-in the subtitle trigger sends, which derives progress from elapsed
 * time and so calls anything abandoned watched.
 */
async function trackMdblistWatchStatus(
  parsedId: ParsedMediaId,
  config: any,
  options: { action?: 'checkin' | 'start' | 'pause' | 'stop'; progress?: number } = {}
): Promise<void> {
  try {
    const { checkinMovie, checkinEpisode } = require('../utils/mdbList');
    const apiKey = config.apiKeys.mdblist;

    if (!apiKey) {
      logger.debug('[Mdblist Watch Tracking] Skipping tracking - missing MDBList API key');
      return;
    }

    if (parsedId.type === 'movie') {
      const ids = normalizeIdsForMovie(parsedId);
      if (!ids) {
        logger.debug(`[Mdblist Watch Tracking] No valid identifiers for movie provider ${parsedId.provider}`);
        return;
      }

      logger.debug(`[Mdblist Watch Tracking] Checkin in movie (${buildIdSummary(ids)})`);
      await checkinMovie(ids, apiKey, options);
      return;
    }

    if (parsedId.type === 'series') {
      const resolution = await resolveSeriesIds(parsedId, config);
      if (!resolution) {
        logger.debug(`[Mdblist Watch Tracking] Unable to resolve identifiers for series provider ${parsedId.provider}`);
        return;
      }

      logger.debug(
        `[Mdblist Watch Tracking] Checkin in for episode (${buildIdSummary(resolution.ids)}) S${resolution.season}E${resolution.episode}`
      );
      await checkinEpisode(resolution.ids, resolution.season, resolution.episode, apiKey, options);
      return;
    }

    logger.debug(`[Mdblist Watch Tracking] Unsupported content type for tracking: ${parsedId.type}`);
  } catch (error: any) {
    logger.error(`[Mdblist Watch Tracking] Unexpected tracking error: ${error.message}`, {
      stack: error.stack
    });
  }
}

// A scrobble stop would open and finalise a session for something nobody
// played, so this goes to /sync/history instead.
async function creditWatch(parsedId: ParsedMediaId, config: any): Promise<void> {
  const mediaType = parsedId.type === 'movie' ? 'movie' : 'series';

  await eachHistoryService(parsedId, config, mediaType, 'addToHistory', 'Crediting a watch');
  await clearMdblistResumePoint(parsedId, config, mediaType);
  await publicMetaDbHistory(parsedId, config, mediaType, 'watched');
}

// PublicMetaDB keeps plays rather than a watched flag and is keyed on TMDB.
async function publicMetaDbHistory(
  parsedId: ParsedMediaId,
  config: any,
  mediaType: 'movie' | 'series',
  action: 'watched' | 'unwatch'
): Promise<void> {
  if (!shouldTrackServiceMediaType(config, 'publicmetadb', mediaType)) return;
  try {
    await checkinPublicMetaDB(parsedId, config, { action });
  } catch (error: any) {
    logger.error(`[PublicMetaDB] ${action} failed: ${error.message}`);
  }
}

async function eachHistoryService(
  parsedId: ParsedMediaId,
  config: any,
  mediaType: 'movie' | 'series',
  method: 'addToHistory' | 'removeFromHistory',
  what: string
): Promise<void> {
  for (const service of ['trakt', 'simkl', 'mdblist'] as const) {
    if (!shouldTrackServiceMediaType(config, service, mediaType)) continue;
    try {
      let utils: any;
      let credential: string | undefined;

      if (service === 'mdblist') {
        utils = require('../utils/mdbList');
        credential = config.apiKeys?.mdblist;
      } else {
        utils = service === 'trakt'
          ? require('../utils/traktUtils')
          : require('../utils/simklUtils');
        const tokenId = service === 'trakt'
          ? config.apiKeys?.traktTokenId
          : config.apiKeys?.simklTokenId;
        if (!tokenId) continue;
        const token = service === 'trakt'
          ? await utils.getTraktToken(tokenId)
          : await utils.getSimklToken(tokenId);
        credential = token?.access_token;
      }
      if (!credential) continue;

      if (parsedId.type === 'movie') {
        const ids = normalizeIdsForMovie(parsedId);
        if (ids) await utils[method](ids, credential);
      } else {
        const resolution = await resolveSeriesIds(parsedId, config, service === 'simkl');
        if (resolution) {
          await utils[method](resolution.ids, credential, resolution.season, resolution.episode);
        }
      }
    } catch (error: any) {
      logger.error(`[${service}] ${what} failed: ${error.message}`);
    }
  }
}

async function unwatch(parsedId: ParsedMediaId, config: any): Promise<void> {
  const mediaType = parsedId.type === 'movie' ? 'movie' : 'series';
  await eachHistoryService(parsedId, config, mediaType, 'removeFromHistory', 'Unwatch');
  await clearMdblistResumePoint(parsedId, config, mediaType);
  await publicMetaDbHistory(parsedId, config, mediaType, 'unwatch');
}

// MDBList holds a resume point apart from watched status, so a mark either way
// leaves the item sitting in continue-watching until the session is cleared.
async function clearMdblistResumePoint(
  parsedId: ParsedMediaId,
  config: any,
  mediaType: 'movie' | 'series'
): Promise<void> {
  if (!shouldTrackServiceMediaType(config, 'mdblist', mediaType)) return;

  const apiKey = config.apiKeys?.mdblist;
  if (!apiKey) return;

  try {
    const { clearScrobbleSession } = require('../utils/mdbList');

    if (parsedId.type === 'movie') {
      const ids = normalizeIdsForMovie(parsedId);
      if (ids) await clearScrobbleSession(ids, apiKey);
      return;
    }

    const resolution = await resolveSeriesIds(parsedId, config, false);
    if (resolution) {
      await clearScrobbleSession(resolution.ids, apiKey, resolution.season, resolution.episode);
    }
  } catch (error: any) {
    logger.error(`[MDBList] Clearing the resume point failed: ${error.message}`);
  }
}

/**
 * `options` selects the Simkl call. Left out, this is the fire-and-forget
 * check-in the subtitle trigger has always sent. A playback event passes start
 * or stop with a real progress instead, which is what stops an abandoned
 * episode being marked watched when its runtime elapses.
 */
async function checkinSimkl(
  parsedId: ParsedMediaId,
  config: any,
  options: { action?: 'checkin' | 'start' | 'pause' | 'stop'; progress?: number } = {}
): Promise<void> {
  try {
    const { checkinSeries, checkinMovie, getSimklToken } = require('../utils/simklUtils');
    const tokenId = config.apiKeys?.simklTokenId;
    if (!tokenId) {
      logger.debug('[Simkl Checkin] Skipping checkin - missing token Id');
      return;
    }

    const token = await getSimklToken(tokenId);
    const accessToken = token?.access_token;
    if (!accessToken) {
      logger.warn(`[Simkl Checkin] Skipping checkin - missing or invalid Simkl token for tokenId ${tokenId}`);
      return;
    }

    if (parsedId.type === 'movie') {
      const ids = normalizeIdsForMovie(parsedId);
      if (!ids) {
        logger.debug(`[Simkl Checkin] No valid identifiers for movie provider ${parsedId.provider}`);
        return;
      }

      logger.debug(`[Simkl Checkin] Tracking movie (${buildIdSummary(ids)})`);
      await checkinMovie(ids, accessToken, options);
      return;
    }

    if (parsedId.type === 'series') {
      const resolution = await resolveSeriesIds(parsedId, config, true);
      if (!resolution) {
        logger.debug(`[Simkl Checkin] Unable to resolve identifiers for series provider ${parsedId.provider}`);
        return;
      }

      logger.debug(
        `[Simkl Checkin] Checkin in episode (${buildIdSummary(resolution.ids)}) S${resolution.season}E${resolution.episode}`
      );
      await checkinSeries(resolution.ids, resolution.season, resolution.episode, accessToken, resolution.fallbackData, options);
      return;
    }

    logger.debug(`[Simkl Checkin] Unsupported content type for tracking: ${parsedId.type}`);
  } catch (error: any) {
    logger.error(`[Simkl Checkin] Unexpected tracking error: ${error.message}`, {
      stack: error.stack
    });
  }
}

/**
 * `options` selects the Trakt call, matching the other trackers. Left out this
 * is the check-in, which Trakt flips to watched on its own once the runtime has
 * elapsed, whether or not anybody watched it.
 */
async function checkinTrakt(
  parsedId: ParsedMediaId,
  config: any,
  options: { action?: 'checkin' | 'start' | 'pause' | 'stop'; progress?: number } = {}
): Promise<void> {
  try {
    const { checkinSeries, checkinMovie, getTraktToken } = require('../utils/traktUtils');
    const tokenId = config.apiKeys?.traktTokenId;
    const accessToken = await getTraktToken(tokenId);

    if (!accessToken) {
      logger.debug('[Trakt Checkin] Skipping checkin - missing or invalid token');
      return;
    }

    if (parsedId.type === 'movie') {
      const ids = normalizeIdsForMovie(parsedId);
      if (!ids) {
        logger.debug(`[Trakt Checkin] No valid identifiers for movie provider ${parsedId.provider}`);
        return;
      }

      logger.debug(`[Trakt Checkin] Tracking movie (${buildIdSummary(ids)})`);
      await checkinMovie(ids, accessToken, options);
      return;
    }

    if (parsedId.type === 'series') {
      const resolution = await resolveSeriesIds(parsedId, config);
      if (!resolution) {
        logger.debug(`[Trakt Checkin] Unable to resolve identifiers for series provider ${parsedId.provider}`);
        return;
      }

      logger.debug(
        `[Trakt Checkin] Checkin in episode (${buildIdSummary(resolution.ids)}) S${resolution.season}E${resolution.episode}`
      );
      await checkinSeries(resolution.ids, resolution.season, resolution.episode, accessToken, options);
      return;
    }

    logger.debug(`[Trakt Checkin] Unsupported content type for tracking: ${parsedId.type}`);
  } catch (error: any) {
    logger.error(`[Trakt Checkin] Unexpected tracking error: ${error.message}`, {
      stack: error.stack
    });
  }
}

/**
 * PublicMetaDB holds resume points and watch history, with no session to start.
 * Without options this stays the immediate mark-watched the subtitle trigger
 * sends; a stop saves the position, and marks watched only when the sender
 * judged it finished.
 */
async function checkinPublicMetaDB(
  parsedId: ParsedMediaId,
  config: any,
  options: { action?: 'watched' | 'stop' | 'unwatch'; played?: boolean; positionMs?: number; runtimeMs?: number } = {}
): Promise<void> {
  try {
    const { checkinMovie, checkinEpisode } = require('../utils/publicmetadbUtils');
    const apiKey = config.apiKeys?.publicmetadb;

    if (!apiKey) {
      logger.debug('[PublicMetaDB Watch Tracking] Skipping - missing API key');
      return;
    }

    if (parsedId.type === 'movie') {
      const ids = normalizeIdsForMovie(parsedId);
      if (!ids) {
        logger.debug(`[PublicMetaDB Watch Tracking] No valid identifiers for movie provider ${parsedId.provider}`);
        return;
      }
      logger.debug(`[PublicMetaDB Watch Tracking] Tracking movie (${buildIdSummary(ids)})`);
      await checkinMovie(ids, apiKey, options);
      return;
    }

    if (parsedId.type === 'series') {
      const resolution = await resolveSeriesIds(parsedId, config);
      if (!resolution) {
        logger.debug(`[PublicMetaDB Watch Tracking] Unable to resolve identifiers for series provider ${parsedId.provider}`);
        return;
      }
      logger.debug(`[PublicMetaDB Watch Tracking] Tracking episode (${buildIdSummary(resolution.ids)}) S${resolution.season}E${resolution.episode}`);
      await checkinEpisode(resolution.ids, resolution.season, resolution.episode, apiKey, options);
      return;
    }

    logger.debug(`[PublicMetaDB Watch Tracking] Unsupported content type: ${parsedId.type}`);
  } catch (error: any) {
    logger.error(`[PublicMetaDB Watch Tracking] Unexpected tracking error: ${error.message}`, {
      stack: error.stack
    });
  }
}

export {
  handleSubtitleRequest,
  parseMediaId,
  checkinSimkl,
  trackMdblistWatchStatus,
  checkinTrakt,
  checkinPublicMetaDB,
  unwatch,
  creditWatch,
  shouldTrackMdblistWatch,
  shouldTrackAniList
};
module.exports = {
  handleSubtitleRequest,
  parseMediaId,
  checkinSimkl,
  trackMdblistWatchStatus,
  checkinTrakt,
  checkinPublicMetaDB,
  unwatch,
  creditWatch,
  shouldTrackMdblistWatch,
  shouldTrackAniList
};
