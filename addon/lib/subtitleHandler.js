const consola = require('consola');
const idMapper = require('./id-mapper');
const { resolveTmdbEpisodeFromKitsu } = require('./id-mapper');
const { resolveTvdbEpisodeFromAnidbEpisode } = require('./anime-list-mapper');
const anilistTracker = require('./anilistTracker');
const simklUtils = require('../utils/simklUtils');


const logger = consola.withTag('SubtitleHandler');

/**
 * Parse Stremio media IDs into structured identifiers supported by MDBList.
 *
 * Supported ID formats:
 *   Movies:  imdb -> tt1234567
 *            tmdb -> tmdb:123456   or tmdb-localized (still matches tmdb:123456)
 *            trakt -> trakt:123456
 *            kitsu -> kitsu:123456
 *   Series:  imdb -> tt1234567:season:episode
 *            tmdb -> tmdb:123456:season:episode
 *            trakt -> trakt:123456:season:episode
 *            tvdb -> tvdb:123456:season:episode
 *
 * @param {string} id
 * @returns {Object|null} Structured identifier, or null if invalid/unsupported.
 *   Example return for movie:
 *     { type: 'movie', provider: 'tmdb', id: '12345' }
 *   Series:
 *     { type: 'series', provider: 'tvdb', id: '305089', season: 2, episode: 21 }
 */
function parseMediaId(id) {
  if (!id || typeof id !== 'string') {
    logger.debug(`[Watch Tracking] Invalid media ID format - id is ${id === null ? 'null' : id === undefined ? 'undefined' : 'not a string'}, type: ${typeof id}`);
    return null;
  }

  const cleanId = id.trim();
  if (cleanId.length === 0 || cleanId.length > 150) {
    logger.debug(`[Watch Tracking] Invalid media ID format - empty or exceeds maximum length (${cleanId.length})`);
    return null;
  }

  const parts = cleanId.split(':').map(part => part.trim()).filter(Boolean);

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
  let numericId = '';
  let season = null;
  let episode = null;

  if (provider === 'imdb') {
    if (rest.length === 0) {
      numericId = prefix;
      return { type: 'movie', provider, id: numericId };
    }

    if (rest.length === 2) {
      const [seasonStr, episodeStr] = rest;
      season = parseInt(seasonStr, 10);
      episode = parseInt(episodeStr, 10);
      if (Number.isNaN(season) || season < 1 || season > 999) {
        logger.debug(`[Watch Tracking] Invalid season value in IMDb ID: season=${seasonStr}`);
        return null;
      }
      if (Number.isNaN(episode) || episode < 1 || episode > 9999) {
        logger.debug(`[Watch Tracking] Invalid episode value in IMDb ID: episode=${episodeStr}`);
        return null;
      }
      numericId = prefix;
      return { type: 'series', provider, id: numericId, season, episode };
    }

    logger.debug(`[Watch Tracking] Invalid IMDb media ID structure: ${cleanId}`);
    return null;
  }

  if (rest.length === 0) {
    logger.debug(`[Watch Tracking] Missing identifier for provider ${provider}`);
    return null;
  }

  numericId = rest[0];
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
    episode = parseInt(episodeStr, 10);
    if (Number.isNaN(episode) || episode < 1 || episode > 9999) {
      logger.debug(`[Watch Tracking] Invalid episode value for Kitsu provider: ${episodeStr}`);
      return null;
    }
    season = 1;
    return { type: 'series', provider, id: numericId, season, episode };
  }

  if (rest.length === 3) {
    if (!['tmdb', 'tvdb', 'trakt', 'kitsu'].includes(provider)) {
      logger.debug(`[Watch Tracking] Provider ${provider} does not support season/episode structure`);
      return null;
    }

    const [seasonStr, episodeStr] = rest.slice(1);
    season = parseInt(seasonStr, 10);
    episode = parseInt(episodeStr, 10);
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

/**
 * Check if watch tracking should be enabled for this request
 * Security: API keys are never logged or exposed
 * @param {Object} config - User configuration
 * @returns {boolean} - True if tracking should proceed
 */
function shouldTrackMdblistWatch(config) {
  // Check if MDBList API key exists (never log the actual key value)
  if (!config?.apiKeys?.mdblist) {
    logger.debug('[Watch Tracking] Skipped - No MDBList API key configured');
    return false;
  }

  // Check if watch tracking is explicitly disabled
  if (config.mdblistWatchTracking === false) {
    logger.debug('[Watch Tracking] Skipped - Feature disabled in user config');
    return false;
  }

  // Default to boolean true when API key is present
  const enabled = config.mdblistWatchTracking !== false;
  logger.debug(`[Watch Tracking] Enabled - API key present, flag=${enabled}`);
  return enabled;
}

/**
 * Check if AniList watch tracking should be enabled for this request
 * @param {Object} config - User configuration
 * @returns {boolean} - True if AniList tracking should proceed
 */
function shouldTrackAniList(config) {
  // Check if anilistTokenId exists in config (user has connected their account)
  // Token ID is stored in apiKeys.anilistTokenId by the frontend
  if (!config?.apiKeys?.anilistTokenId) {
    logger.debug('[Watch Tracking] AniList skipped - No AniList account connected');
    return false;
  }

  // Check if anilistWatchTracking is enabled
  if (!config.anilistWatchTracking) {
    logger.debug('[Watch Tracking] AniList skipped - Feature disabled in user config');
    return false;
  }

  logger.debug('[Watch Tracking] AniList enabled - Account connected and tracking enabled');
  return true;
}

/**
 * Check if Simkl watch tracking should be enabled for this request
 * @param {Object} config - User configuration
 * @returns {boolean} True if Simkl tracking should proceed
 */
function shouldTrackSimkl(config) {
  // Check if simklTokenId exists in config (user has connected their account)
  if (!config?.apiKeys?.simklTokenId) {
    logger.debug('[Watch Tracking] Simkl skipped - No Simkl account connected');
    return false;
  }

  // Check if simklWatchTracking is enabled
  if (!config.simklWatchTracking) {
    logger.debug('[Watch Tracking] Simkl skipped - Feature disabled in user config');
    return false;
  }

  logger.debug('[Watch Tracking] Simkl enabled - Account connected and tracking enabled');
  return true;
}

/**
 * Check if Trakt watch tracking should be enabled for this request
 * @param {Object} config - User configuration
 * @returns {boolean} True if Trakt tracking should proceed
 */
function shouldTrackTrakt(config) {
  // Check if traktTokenId exists in config (user has connected their account)
  if (!config?.apiKeys?.traktTokenId) {
    logger.debug('[Watch Tracking] Trakt skipped - No Trakt account connected');
    return false;
  }

  // Check if traktWatchTracking is enabled
  if (!config.traktWatchTracking) {
    logger.debug('[Watch Tracking] Trakt skipped - Feature disabled in user config');
    return false;
  }

  logger.debug('[Watch Tracking] Trakt enabled - Account connected and tracking enabled');
  return true;
}

/**
 * Main handler for subtitle requests - coordinates parsing and tracking
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} id - Media ID (e.g., 'tt1234567' or 'tt1234567:2:5')
 * @param {Object} config - User configuration including API keys
 * @param {string} userUUID - User identifier for logging and token retrieval
 * @returns {Object} - Empty subtitle response { subtitles: [] } (synchronous return)
 */
function handleSubtitleRequest(type, id, config, userUUID) {
  try {
    // Debug logging for all watch tracking attempts with media ID and user UUID
    logger.debug(`[Watch Tracking] Subtitle request received, type: ${type}, id: ${id}`);

    // Parse the media ID first (needed for both MDBList and AniList tracking)
    const parsedId = parseMediaId(id);
    if (!parsedId) {
      // Warning logging for invalid media ID formats
      logger.warn(`[Watch Tracking] Failed to parse media ID, id: ${id}, type: ${type}`);
      return { subtitles: [] };
    }

    // MDBList tracking (fire-and-forget)
    if (shouldTrackMdblistWatch(config)) {
      trackMdblistWatchStatus(parsedId, config).catch(error => {
        logger.error(`[Mdblist Watch Tracking] MDBList tracking failed for ${id}: ${error.message}`, {
          stack: error.stack,
          parsedId: parsedId
        });
      });
    }

    // AniList tracking (fire-and-forget) - executes asynchronously without blocking response
    if (shouldTrackAniList(config)) {
      anilistTracker.trackAnimeProgress(parsedId, config, userUUID).catch(error => {
        logger.error(`[Watch Tracking] AniList tracking failed for ${id}: ${error.message}`, {
          stack: error.stack,
          parsedId: parsedId
        });
      });
    }

    // Simkl tracking (fire-and-forget) - executes asynchronously without blocking response
    if (shouldTrackSimkl(config)) {
      checkinSimkl(parsedId, config).catch(error => {
        logger.error(`[Watch Tracking] Simkl tracking failed for ${id}: ${error.message}`, {
          stack: error.stack,
          parsedId: parsedId
        });
      });
    }

    // Trakt tracking (fire-and-forget) - executes asynchronously without blocking response
    if (shouldTrackTrakt(config)) {
      checkinTrakt(parsedId, config).catch(error => {
        logger.error(`[Watch Tracking] Trakt tracking failed for ${id}: ${error.message}`, {
          stack: error.stack,
          parsedId: parsedId
        });
      });
    }

    // Return empty subtitles immediately (before tracking operations complete)
    return { subtitles: [] };

  } catch (error) {
    // Catch any unexpected errors to ensure we always return a valid response
    logger.error(`[Watch Tracking] Subtitle handler error, type: ${type}, id: ${id}, error: ${error.message}`, {
      stack: error.stack
    });
    return { subtitles: [] };
  }
}

/**
 * Track watch status by calling MDBList API (async, fire-and-forget)
 * @param {string} type - Content type ('movie' or 'series')
 * @param {Object} parsedId - Parsed media information
 * @param {Object} config - User configuration
 * @param {string} userUUID - User identifier for logging
 */
function buildIdSummary(ids) {
  return Object.entries(ids || {})
    .map(([key, value]) => `${key}:${value}`)
    .join(', ');
}

function normalizeIdsForMovie(parsedId) {
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

async function resolveSeriesIds(parsedId, config = {}, isSimkl = false) {
  switch (parsedId.provider) {
    case 'imdb':
      return {
        ids: { imdb: parsedId.id },
        season: parsedId.season,
        episode: parsedId.episode
      };
    case 'tvdb':
      return {
        ids: { tvdb: parseInt(parsedId.id, 10) },
        season: parsedId.season,
        episode: parsedId.episode
      };
    case 'tmdb': {
      const mapping = idMapper.getMappingByTmdbId(parsedId.id, 'series');
      if (!mapping) {
        logger.debug(`[Watch Tracking] No mapping found for TMDB series ${parsedId.id}`);
        return null;
      }
      const ids = {};
      if (mapping.imdb_id) ids.imdb = mapping.imdb_id;
      if (mapping.tvdb_id) ids.tvdb = parseInt(mapping.tvdb_id, 10);

      if (Object.keys(ids).length === 0) {
        logger.debug(`[Watch Tracking] TMDB ${parsedId.id} mapping lacks IMDb/TVDB identifiers`);
        return null;
      }

      return { ids, season: parsedId.season, episode: parsedId.episode };
    }
    case 'kitsu': {
      let resolved;
      let fallback;
      if(!isSimkl){
        resolved = await resolveTmdbEpisodeFromKitsu(
          parseInt(parsedId.id, 10),
          parseInt(parsedId.episode, 10),
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
        let tvdbInfo;
        if(anidbId){
          tvdbInfo = resolveTvdbEpisodeFromAnidbEpisode(anidbId, 1, parseInt(parsedId.episode, 10))
        }
        if(tvdbInfo){
          logger.debug(`[tvdb anilist] tvdb anilist mapping: ${JSON.stringify(tvdbInfo)} `)
          resolved = {
            tvdbId: tvdbInfo.tvdbId,
            seasonNumber: tvdbInfo.tvdbSeason,
            episodeNumber: tvdbInfo.tvdbEpisode
          }
        }
        if(malId){
          fallback = {
            malId: malId,
            seasonNumber: 1,
            episodeNumber: parseInt(parsedId.episode, 10)
          }
        }
      }
      

      return {
        ids: { tmdb: resolved.tmdbId, mal: resolved.malId, tvdb: resolved.tvdbId },
        fallbackData: fallback?.malId ? {ids:  {mal: fallback.malId}, season: 1, episode: fallback.episodeNumber} : null,
        season: resolved.seasonNumber,
        episode: resolved.episodeNumber
      };
    }
    default:
      logger.debug(`[Watch Tracking] Unsupported series provider: ${parsedId.provider}`);
      return null;
  }
}

async function trackMdblistWatchStatus(parsedId, config) {
  try {
    // Import MDBList functions dynamically to avoid circular dependencies
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
      await checkinMovie(ids, apiKey);
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
      await checkinEpisode(resolution.ids, resolution.season, resolution.episode, apiKey);
      return;
    }

    logger.debug(`[Mdblist Watch Tracking] Unsupported content type for tracking: ${parsedId.type}`);
  } catch (error) {
    logger.error(`[Mdblist Watch Tracking] Unexpected tracking error: ${error.message}`, {
      stack: error.stack
    });
  }
}

async function checkinSimkl(parsedId, config) {
  try {
    // Import MDBList functions dynamically to avoid circular dependencies
    const { checkinSeries, checkinMovie, getSimklToken } = require('../utils/simklUtils');
    const tokenId = config.apiKeys?.simklTokenId;
    const token = await getSimklToken(tokenId);
    const accessToken = token.access_token;

    if (!tokenId) {
      logger.debug('[Simkl Checkin] Skipping checkin - missing token Id');
      return;
    }

    if (parsedId.type === 'movie') {
      const ids = normalizeIdsForMovie(parsedId);
      if (!ids) {
        logger.debug(`[Simkl Checkin] No valid identifiers for movie provider ${parsedId.provider}`);
        return;
      }

      logger.debug(`[Simkl Checkin] Checking in movie (${buildIdSummary(ids)})`);
      await checkinMovie(ids, accessToken);
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
      await checkinSeries(resolution.ids, resolution.season, resolution.episode, accessToken, resolution.fallbackData);
      return;
    }

    logger.debug(`[Simkl Checkin] Unsupported content type for tracking: ${parsedId.type}`);
  } catch (error) {
    logger.error(`[Simkl Checkin] Unexpected tracking error: ${error.message}`, {
      stack: error.stack
    });
  }
}

async function checkinTrakt(parsedId, config) {
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

      logger.debug(`[Trakt Checkin] Checking in movie (${buildIdSummary(ids)})`);
      await checkinMovie(ids, accessToken);
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
      await checkinSeries(resolution.ids, resolution.season, resolution.episode, accessToken);
      return;
    }

    logger.debug(`[Trakt Checkin] Unsupported content type for tracking: ${parsedId.type}`);
  } catch (error) {
    logger.error(`[Trakt Checkin] Unexpected tracking error: ${error.message}`, {
      stack: error.stack
    });
  }
}

module.exports = {
  handleSubtitleRequest,
  parseMediaId,
  shouldTrackMdblistWatch,
  shouldTrackAniList
};
