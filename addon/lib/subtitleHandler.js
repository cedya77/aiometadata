const consola = require('consola');

// Configure logging level based on environment
const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
consola.level = consola.LogLevels[logLevel?.toLowerCase?.()] ?? (process.env.NODE_ENV === 'production' ? 3 : 4);
const logger = consola.create({ tag: 'SubtitleHandler' });

/**
 * Parse media ID to extract IMDb ID, season, and episode information
 * @param {string} id - Media ID (e.g., 'tt1234567' or 'tt1234567:2:5')
 * @returns {Object|null} - Parsed media info or null if invalid
 */
function parseMediaId(id) {
  if (!id || typeof id !== 'string') {
    logger.warn(`Invalid media ID format: ${id}`);
    return null;
  }

  // Remove any whitespace
  const cleanId = id.trim();

  // Check for IMDb ID format
  if (!cleanId.startsWith('tt')) {
    logger.warn(`Media ID does not start with 'tt': ${cleanId}`);
    return null;
  }

  // Split by colon to check for series format
  const parts = cleanId.split(':');

  // Movie format: tt1234567
  if (parts.length === 1) {
    const imdbId = parts[0];
    
    // Validate IMDb ID format (tt followed by digits)
    if (!/^tt\d+$/.test(imdbId)) {
      logger.warn(`Invalid IMDb ID format: ${imdbId}`);
      return null;
    }

    return {
      imdbId,
      season: null,
      episode: null,
      isMovie: true
    };
  }

  // Series format: tt1234567:2:5
  if (parts.length === 3) {
    const imdbId = parts[0];
    const season = parseInt(parts[1], 10);
    const episode = parseInt(parts[2], 10);

    // Validate IMDb ID format
    if (!/^tt\d+$/.test(imdbId)) {
      logger.warn(`Invalid IMDb ID format in series: ${imdbId}`);
      return null;
    }

    // Validate season and episode are positive integers
    if (isNaN(season) || season < 1 || isNaN(episode) || episode < 1) {
      logger.warn(`Invalid season/episode numbers: season=${parts[1]}, episode=${parts[2]}`);
      return null;
    }

    return {
      imdbId,
      season,
      episode,
      isMovie: false
    };
  }

  // Invalid format
  logger.warn(`Invalid media ID format (unexpected parts count): ${cleanId}`);
  return null;
}

/**
 * Check if watch tracking should be enabled for this request
 * @param {Object} config - User configuration
 * @returns {boolean} - True if tracking should proceed
 */
function shouldTrackWatch(config) {
  // Check if MDBList API key exists
  if (!config?.apiKeys?.mdblist) {
    logger.debug('Watch tracking skipped: No MDBList API key configured');
    return false;
  }

  // Check if watch tracking is explicitly disabled
  if (config.mdblistWatchTracking?.enabled === false) {
    logger.debug('Watch tracking skipped: Feature disabled in config');
    return false;
  }

  // Default to enabled if API key exists
  return true;
}

/**
 * Main handler for subtitle requests - coordinates parsing and tracking
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} id - Media ID (e.g., 'tt1234567' or 'tt1234567:2:5')
 * @param {Object} config - User configuration including API keys
 * @param {string} userUUID - User identifier for logging
 * @returns {Promise<Object>} - Empty subtitle response { subtitles: [] }
 */
async function handleSubtitleRequest(type, id, config, userUUID) {
  try {
    logger.debug(`Subtitle request received - userUUID: ${userUUID}, type: ${type}, id: ${id}`);

    // Check if tracking should be enabled
    if (!shouldTrackWatch(config)) {
      return { subtitles: [] };
    }

    // Parse the media ID
    const parsedId = parseMediaId(id);
    if (!parsedId) {
      logger.warn(`Failed to parse media ID - userUUID: ${userUUID}, id: ${id}`);
      return { subtitles: [] };
    }

    // Log the tracking attempt
    const mediaInfo = parsedId.isMovie 
      ? `movie ${parsedId.imdbId}` 
      : `series ${parsedId.imdbId} S${parsedId.season}E${parsedId.episode}`;
    logger.debug(`Watch tracking initiated - userUUID: ${userUUID}, media: ${mediaInfo}`);

    // Fire-and-forget: Initiate async tracking without awaiting
    // This ensures we return the subtitle response immediately
    trackWatchStatus(type, parsedId, config, userUUID).catch(error => {
      // Catch and log errors without propagating them
      logger.error(`Watch tracking failed - userUUID: ${userUUID}, media: ${mediaInfo}, error: ${error.message}`);
    });

    // Return empty subtitles immediately
    return { subtitles: [] };

  } catch (error) {
    // Catch any unexpected errors to ensure we always return a valid response
    logger.error(`Subtitle handler error - userUUID: ${userUUID}, type: ${type}, id: ${id}, error: ${error.message}`);
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
async function trackWatchStatus(type, parsedId, config, userUUID) {
  try {
    // Import MDBList functions dynamically to avoid circular dependencies
    const { markMovieAsWatched, markEpisodeAsWatched } = require('../utils/mdbList');

    const apiKey = config.apiKeys.mdblist;

    if (parsedId.isMovie) {
      // Track movie
      logger.debug(`Marking movie as watched - userUUID: ${userUUID}, imdbId: ${parsedId.imdbId}`);
      await markMovieAsWatched(parsedId.imdbId, apiKey);
      logger.info(`Movie marked as watched - userUUID: ${userUUID}, imdbId: ${parsedId.imdbId}`);
    } else {
      // Track episode
      logger.debug(`Marking episode as watched - userUUID: ${userUUID}, imdbId: ${parsedId.imdbId}, season: ${parsedId.season}, episode: ${parsedId.episode}`);
      await markEpisodeAsWatched(parsedId.imdbId, parsedId.season, parsedId.episode, apiKey);
      logger.info(`Episode marked as watched - userUUID: ${userUUID}, imdbId: ${parsedId.imdbId}, S${parsedId.season}E${parsedId.episode}`);
    }
  } catch (error) {
    // Log error but don't throw - this is fire-and-forget
    const mediaInfo = parsedId.isMovie 
      ? `movie ${parsedId.imdbId}` 
      : `series ${parsedId.imdbId} S${parsedId.season}E${parsedId.episode}`;
    logger.error(`MDBList API call failed - userUUID: ${userUUID}, media: ${mediaInfo}, error: ${error.message}`);
    
    // Log additional error details if available
    if (error.response) {
      logger.error(`MDBList API error details - status: ${error.response.status}, data: ${JSON.stringify(error.response.data)}`);
    }
  }
}

module.exports = {
  handleSubtitleRequest,
  parseMediaId,
  shouldTrackWatch
};
