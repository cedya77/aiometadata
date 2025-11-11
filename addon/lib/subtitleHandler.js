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
  // Input validation: Check for null, undefined, or non-string types
  if (!id || typeof id !== 'string') {
    logger.debug(`[Watch Tracking] Invalid media ID format - id is ${id === null ? 'null' : id === undefined ? 'undefined' : 'not a string'}, type: ${typeof id}`);
    return null;
  }

  // Remove any whitespace and validate length
  const cleanId = id.trim();
  
  // Prevent excessively long input
  if (cleanId.length > 100) {
    logger.debug(`[Watch Tracking] Invalid media ID format - exceeds maximum length: ${cleanId.length} characters`);
    return null;
  }
  
  // Validate IMDb ID format prefix
  if (!cleanId.startsWith('tt')) {
    logger.debug(`[Watch Tracking] Invalid media ID format - does not start with 'tt': ${cleanId.substring(0, 20)}`);
    return null;
  }

  // Split by colon to check for series format
  const parts = cleanId.split(':');

  // Movie format: tt1234567
  if (parts.length === 1) {
    const imdbId = parts[0];
    
    // Sanitize IMDb ID: Must match pattern /^tt\d+$/ (tt followed by digits only)
    if (!/^tt\d+$/.test(imdbId)) {
      logger.debug(`[Watch Tracking] Invalid IMDb ID format - expected 'tt' followed by digits: ${imdbId.substring(0, 20)}`);
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

    // Sanitize IMDb ID: Must match pattern /^tt\d+$/ (tt followed by digits only)
    if (!/^tt\d+$/.test(imdbId)) {
      logger.debug(`[Watch Tracking] Invalid IMDb ID format in series - expected 'tt' followed by digits: ${imdbId.substring(0, 20)}`);
      return null;
    }

    // Validate season and episode are positive integers (must be >= 1)
    if (isNaN(season) || season < 1 || isNaN(episode) || episode < 1) {
      logger.debug(`[Watch Tracking] Invalid season/episode numbers - season=${parts[1]} (parsed: ${season}), episode=${parts[2]} (parsed: ${episode}), mediaId: ${cleanId.substring(0, 50)}`);
      return null;
    }
    
    // Validate reasonable upper bounds for season/episode numbers
    if (season > 999 || episode > 9999) {
      logger.debug(`[Watch Tracking] Season/episode numbers exceed reasonable limits - season=${season}, episode=${episode}`);
      return null;
    }

    return {
      imdbId,
      season,
      episode,
      isMovie: false
    };
  }

  // Invalid format - unexpected number of parts
  logger.debug(`[Watch Tracking] Invalid media ID format - unexpected structure (${parts.length} parts): ${cleanId.substring(0, 50)}`);
  return null;
}

/**
 * Check if watch tracking should be enabled for this request
 * Security: API keys are never logged or exposed
 * @param {Object} config - User configuration
 * @returns {boolean} - True if tracking should proceed
 */
function shouldTrackWatch(config) {
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
 * Main handler for subtitle requests - coordinates parsing and tracking
 * @param {string} type - Content type ('movie' or 'series')
 * @param {string} id - Media ID (e.g., 'tt1234567' or 'tt1234567:2:5')
 * @param {Object} config - User configuration including API keys
 * @param {string} userUUID - User identifier for logging
 * @returns {Object} - Empty subtitle response { subtitles: [] } (synchronous return)
 */
function handleSubtitleRequest(type, id, config, userUUID) {
  try {
    // Debug logging for all watch tracking attempts with media ID and user UUID
    logger.debug(`[Watch Tracking] Subtitle request received, type: ${type}, id: ${id}`);

    // Check if tracking should be enabled
    if (!shouldTrackWatch(config)) {
      return { subtitles: [] };
    }

    // Parse the media ID
    const parsedId = parseMediaId(id);
    if (!parsedId) {
      // Warning logging for invalid media ID formats
      logger.warn(`[Watch Tracking] Failed to parse media ID, id: ${id}, type: ${type}`);
      return { subtitles: [] };
    }

    // Log the tracking attempt with full details
    const mediaInfo = parsedId.isMovie 
      ? `movie ${parsedId.imdbId}` 
      : `series ${parsedId.imdbId} S${parsedId.season}E${parsedId.episode}`;
    logger.debug(`[Watch Tracking] Tracking attempt initiated, media: ${mediaInfo}, type: ${type}`);

    // Initiate async tracking without awaiting
    trackWatchStatus(type, parsedId, config, userUUID).catch(error => {
      logger.error(`[Watch Tracking] Tracking failed, media: ${mediaInfo}, error: ${error.message}`, {
        stack: error.stack,
        type: type,
        parsedId: parsedId
      });
    });

    // Return empty subtitles immediately
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
async function trackWatchStatus(type, parsedId, config, userUUID) {
  try {
    // Import MDBList functions dynamically to avoid circular dependencies
    const { markMovieAsWatched, markEpisodeAsWatched } = require('../utils/mdbList');

    const apiKey = config.apiKeys.mdblist;

    // Call MDBList API functions (they handle their own logging)
    if (parsedId.isMovie) {
      await markMovieAsWatched(parsedId.imdbId, apiKey);
    } else {
      await markEpisodeAsWatched(parsedId.imdbId, parsedId.season, parsedId.episode, apiKey);
    }
  } catch (error) {
    // Only log unexpected errors that weren't caught by MDBList functions
    const mediaInfo = parsedId.isMovie 
      ? `movie ${parsedId.imdbId}` 
      : `series ${parsedId.imdbId} S${parsedId.season}E${parsedId.episode}`;
    
    logger.error(`[Watch Tracking] Unexpected error, media: ${mediaInfo}, error: ${error.message}`, {
      stack: error.stack
    });
  }
}

module.exports = {
  handleSubtitleRequest,
  parseMediaId,
  shouldTrackWatch
};
