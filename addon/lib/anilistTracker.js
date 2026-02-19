/**
 * AniList Watch Tracking Module
 * 
 * Provides functionality to automatically sync anime watch progress to AniList.
 * Uses the existing OAuth token storage infrastructure and anime ID mapping system.
 * 
 * @module anilistTracker
 */

const consola = require('consola');
const { httpPost } = require('../utils/httpClient');
const database = require('./database');
const idMapper = require('./id-mapper');
const { resolveAnidbEpisodeFromTvdbEpisode } = require('./anime-list-mapper');


const logger = consola.withTag('AniListTracker');

// AniList API configuration
const ANILIST_GRAPHQL_URL = 'https://graphql.anilist.co';
const ANILIST_AUTH_URL = 'https://anilist.co/api/v2/oauth/authorize';
const ANILIST_TOKEN_URL = 'https://anilist.co/api/v2/oauth/token';

// Environment variables for OAuth
const ANILIST_CLIENT_ID = process.env.ANILIST_CLIENT_ID;
const ANILIST_CLIENT_SECRET = process.env.ANILIST_CLIENT_SECRET;

// Token expiration buffer (5 minutes in milliseconds)
const TOKEN_EXPIRATION_BUFFER_MS = 5 * 60 * 1000;

// Request timeout (10 seconds)
const REQUEST_TIMEOUT_MS = 10000;

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s

/**
 * AniList media list status types
 * @typedef {'CURRENT' | 'COMPLETED' | 'PAUSED' | 'DROPPED' | 'PLANNING' | 'REPEATING'} MediaListStatus
 */

/**
 * @typedef {Object} AniListMediaEntry
 * @property {number} id - Media list entry ID
 * @property {MediaListStatus} status - Current watch status
 * @property {number} progress - Number of episodes watched
 * @property {number} score - User's score for the media
 */

/**
 * @typedef {Object} AniListMedia
 * @property {number} id - AniList media ID
 * @property {number} idMal - MyAnimeList ID
 * @property {number|null} episodes - Total episode count (null if unknown)
 * @property {AniListMediaEntry|null} mediaListEntry - User's list entry (null if not on list)
 */

/**
 * @typedef {Object} ParsedMediaId
 * @property {string} type - Content type ('movie' or 'series')
 * @property {string} provider - ID provider ('imdb', 'kitsu', 'tmdb', 'tvdb', etc.)
 * @property {string} id - The media ID
 * @property {number} [season] - Season number (for series)
 * @property {number} [episode] - Episode number (for series)
 */

/**
 * Check if a token is expired or about to expire
 * A token is considered expired if current time is within 5 minutes of expiration
 * 
 * @param {number} expiresAt - Token expiration timestamp in milliseconds
 * @returns {boolean} True if token is expired or about to expire
 */
function isTokenExpired(expiresAt) {
  const numericExpiry = Number(expiresAt);
  if (!Number.isFinite(numericExpiry) || numericExpiry <= 0) {
    return true;
  }
  const now = Date.now();
  return now >= (numericExpiry - TOKEN_EXPIRATION_BUFFER_MS);
}

/**
 * Get a valid access token for a user, refreshing if necessary
 * 
 * @param {string} userUUID - User's UUID
 * @returns {Promise<string|null>} Valid access token or null if unavailable
 */
async function getValidAccessToken(userUUID) {
  try {
    // Get user config to find the anilistTokenId
    const config = await database.getUserConfig(userUUID);
    // Token ID is stored in apiKeys.anilistTokenId by the frontend
    const anilistTokenId = config?.apiKeys?.anilistTokenId;
    if (!config || !anilistTokenId) {
      logger.debug(`[AniList Tracker] No AniList token ID found for user ${userUUID}`);
      return null;
    }

    // Get the OAuth token from database
    const tokenData = await database.getOAuthToken(anilistTokenId);
    if (!tokenData) {
      logger.debug(`[AniList Tracker] No OAuth token found for token ID ${anilistTokenId}`);
      return null;
    }

    if (isTokenExpired(tokenData.expires_at)) {
      logger.warn(`[AniList Tracker] Token expired for user ${userUUID}. AniList does not support refresh tokens — user must re-authenticate.`);
      return null;
    }

    return tokenData.access_token;
  } catch (error) {
    logger.error(`[AniList Tracker] Error getting valid access token for user ${userUUID}:`, error);
    return null;
  }
}


/**
 * Check if an error is retryable (rate limit or server error)
 * 
 * @param {Error} error - The error to check
 * @returns {boolean} True if the error is retryable
 */
function isRetryableError(error) {
  const status = error?.response?.status;
  
  // Retry on rate limit (429)
  if (status === 429) {
    return true;
  }
  
  // Retry on server errors (5xx)
  if (status >= 500 && status < 600) {
    return true;
  }
  
  // Retry on network timeouts (no status code)
  if (!status && (error.code === 'UND_ERR_CONNECT_TIMEOUT' || 
                  error.code === 'UND_ERR_HEADERS_TIMEOUT' ||
                  error.code === 'UND_ERR_BODY_TIMEOUT' ||
                  error.code === 'ETIMEDOUT' ||
                  error.code === 'ECONNRESET' ||
                  error.code === 'ECONNREFUSED')) {
    return true;
  }
  
  return false;
}

/**
 * Extract error details from an error object for logging
 * 
 * @param {Error} error - The error to extract details from
 * @returns {Object} Error details object
 */
function extractErrorDetails(error) {
  return {
    message: error.message || 'Unknown error',
    status: error?.response?.status,
    code: error.code,
    data: error?.response?.data
  };
}

/**
 * Make a rate-limited request to AniList GraphQL API with retry logic
 * 
 * Implements exponential backoff with delays of 1s, 2s, 4s between retries.
 * Only retries on rate limit (429) and server errors (5xx).
 * Maximum 3 retry attempts.
 * 
 * @param {Function} requestFn - Function that returns a promise for the request
 * @param {number} maxRetries - Maximum number of retries (default: MAX_RETRIES)
 * @returns {Promise<Object>} Response data
 * @throws {Error} If all retries are exhausted or error is not retryable
 */
async function makeRateLimitedRequest(requestFn, maxRetries = MAX_RETRIES) {
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await requestFn();
      return response;
    } catch (error) {
      lastError = error;
      const errorDetails = extractErrorDetails(error);
      
      // Check if we should retry this error
      const shouldRetry = isRetryableError(error);
      
      // Don't retry if error is not retryable or we've exhausted retries
      if (!shouldRetry || attempt >= maxRetries) {
        if (attempt > 0) {
          logger.warn(`[AniList Tracker] Request failed after ${attempt + 1} attempts: ${errorDetails.message} (status: ${errorDetails.status || 'N/A'})`);
        }
        throw error;
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
      logger.debug(`[AniList Tracker] Request failed with status ${errorDetails.status || errorDetails.code}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Parse and handle GraphQL errors from AniList API response
 * 
 * @param {Object} data - Response data from AniList API
 * @returns {{hasErrors: boolean, errors: Array, isNotFound: boolean, isUnauthorized: boolean, isRateLimited: boolean}}
 */
function parseGraphQLErrors(data) {
  const result = {
    hasErrors: false,
    errors: [],
    isNotFound: false,
    isUnauthorized: false,
    isRateLimited: false
  };
  
  if (!data?.errors || !Array.isArray(data.errors) || data.errors.length === 0) {
    return result;
  }
  
  result.hasErrors = true;
  result.errors = data.errors;
  
  for (const error of data.errors) {
    const status = error.status;
    const message = error.message || '';
    
    // Check for NOT_FOUND errors
    if (status === 404 || message.includes('Not Found') || message.includes('not found')) {
      result.isNotFound = true;
    }
    
    // Check for UNAUTHORIZED errors
    if (status === 401 || status === 403 || message.includes('Unauthorized') || message.includes('Invalid token')) {
      result.isUnauthorized = true;
    }
    
    // Check for rate limit errors
    if (status === 429 || message.includes('rate limit') || message.includes('Too Many Requests')) {
      result.isRateLimited = true;
    }
    
    // Log each error for debugging
    logger.debug(`[AniList Tracker] GraphQL error: ${message} (status: ${status || 'N/A'})`);
  }
  
  return result;
}

/**
 * Get the current media status from AniList for a specific anime
 * 
 * Uses retry logic with exponential backoff for rate limits and server errors.
 * Handles GraphQL errors gracefully without blocking user experience.
 * 
 * @param {number} anilistId - AniList media ID
 * @param {string} accessToken - Valid OAuth access token
 * @returns {Promise<AniListMedia|null>} Media information or null if not found/error
 */
async function getMediaStatus(anilistId, accessToken) {
  if (!anilistId || !accessToken) {
    logger.warn('[AniList Tracker] getMediaStatus called with missing anilistId or accessToken');
    return null;
  }

  logger.debug(`[AniList Tracker] Fetching media status for AniList ID ${anilistId}`);

  const query = `
    query ($mediaId: Int) {
      Media(id: $mediaId, type: ANIME) {
        id
        idMal
        episodes
        mediaListEntry {
          id
          status
          progress
          score
        }
      }
    }
  `;

  try {
    const response = await makeRateLimitedRequest(() => 
      httpPost(ANILIST_GRAPHQL_URL, {
        query,
        variables: { mediaId: parseInt(anilistId, 10) }
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: REQUEST_TIMEOUT_MS
      })
    );

    const data = response.data;

    // Handle GraphQL errors using enhanced error parsing
    const graphqlErrors = parseGraphQLErrors(data);
    if (graphqlErrors.hasErrors) {
      // NOT_FOUND is not an error, just means anime doesn't exist on AniList
      if (graphqlErrors.isNotFound) {
        logger.debug(`[AniList Tracker] Media not found for AniList ID ${anilistId}`);
        return null;
      }
      
      // Log specific error messages for debugging
      const errorMessages = graphqlErrors.errors.map(e => e.message).join(', ');
      logger.error(`[AniList Tracker] GraphQL error getting media status: ${errorMessages}`);
      return null;
    }

    if (!data.data || !data.data.Media) {
      logger.debug(`[AniList Tracker] No media data returned for AniList ID ${anilistId}`);
      return null;
    }

    const media = data.data.Media;
    
    logger.debug(`[AniList Tracker] Got media status for AniList ID ${anilistId}: episodes=${media.episodes}, progress=${media.mediaListEntry?.progress || 0}`);

    return {
      id: media.id,
      idMal: media.idMal,
      episodes: media.episodes,
      mediaListEntry: media.mediaListEntry ? {
        id: media.mediaListEntry.id,
        status: media.mediaListEntry.status,
        progress: media.mediaListEntry.progress,
        score: media.mediaListEntry.score
      } : null
    };
  } catch (error) {
    // Log error but don't propagate - ensures user experience is not blocked
    const errorDetails = extractErrorDetails(error);
    logger.error(`[AniList Tracker] Error fetching media status for AniList ID ${anilistId}: ${errorDetails.message} (status: ${errorDetails.status || 'N/A'})`);
    return null;
  }
}

/**
 * Determine the appropriate media list status based on progress
 * 
 * @param {number} episode - Current episode watched
 * @param {number|null} totalEpisodes - Total episodes (null if unknown)
 * @returns {MediaListStatus} The appropriate status
 */
function determineStatus(episode, totalEpisodes) {
  // If total episodes is known and we've watched all of them, mark as COMPLETED
  if (totalEpisodes !== null && totalEpisodes > 0 && episode >= totalEpisodes) {
    return 'COMPLETED';
  }
  // Otherwise, mark as CURRENT (watching)
  return 'CURRENT';
}

/**
 * Update the watch progress for an anime on AniList
 * 
 * Uses retry logic with exponential backoff for rate limits and server errors.
 * Handles GraphQL errors gracefully without blocking user experience.
 * 
 * @param {number} anilistId - AniList media ID
 * @param {number} episode - Episode number watched
 * @param {number|null} totalEpisodes - Total episodes (null if unknown)
 * @param {string} accessToken - Valid OAuth access token
 * @returns {Promise<boolean>} True if update was successful
 */
async function updateProgress(anilistId, episode, totalEpisodes, accessToken) {
  if (!anilistId || !accessToken) {
    logger.warn('[AniList Tracker] updateProgress called with missing anilistId or accessToken');
    return false;
  }

  if (typeof episode !== 'number' || episode < 0) {
    logger.warn(`[AniList Tracker] Invalid episode number: ${episode}`);
    return false;
  }

  // Determine the appropriate status based on progress
  const status = determineStatus(episode, totalEpisodes);

  logger.debug(`[AniList Tracker] Updating progress for AniList ID ${anilistId}: episode=${episode}, totalEpisodes=${totalEpisodes}, status=${status}`);

  const mutation = `
    mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) {
      SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
        id
        progress
        status
      }
    }
  `;

  try {
    const response = await makeRateLimitedRequest(() =>
      httpPost(ANILIST_GRAPHQL_URL, {
        query: mutation,
        variables: {
          mediaId: parseInt(anilistId, 10),
          progress: episode,
          status: status
        }
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: REQUEST_TIMEOUT_MS
      })
    );

    const data = response.data;

    // Handle GraphQL errors using enhanced error parsing
    const graphqlErrors = parseGraphQLErrors(data);
    if (graphqlErrors.hasErrors) {
      // Log specific error messages for debugging
      const errorMessages = graphqlErrors.errors.map(e => e.message).join(', ');
      logger.error(`[AniList Tracker] GraphQL error updating progress: ${errorMessages}`);
      
      // Check for specific error types
      if (graphqlErrors.isUnauthorized) {
        logger.warn('[AniList Tracker] Token may be invalid - user may need to re-authenticate');
      }
      if (graphqlErrors.isRateLimited) {
        logger.warn('[AniList Tracker] Rate limited by AniList API');
      }
      
      return false;
    }

    if (!data.data || !data.data.SaveMediaListEntry) {
      logger.error('[AniList Tracker] Invalid response from SaveMediaListEntry mutation');
      return false;
    }

    const result = data.data.SaveMediaListEntry;
    logger.info(`[AniList Tracker] Successfully updated AniList ID ${anilistId}: progress=${result.progress}, status=${result.status}`);

    return true;
  } catch (error) {
    // Log error but don't propagate - ensures user experience is not blocked
    const errorDetails = extractErrorDetails(error);
    logger.error(`[AniList Tracker] Error updating progress for AniList ID ${anilistId}: ${errorDetails.message} (status: ${errorDetails.status || 'N/A'})`);
    return false;
  }
}

/**
 * Resolve an AniList ID and episode number from various ID providers
 * 
 * Supported providers:
 * - IMDB: Uses TVDB mapping + resolveAnidbEpisodeFromTvdbEpisode → AniList ID
 * - Kitsu: Direct mapping via getMappingByKitsuId → AniList ID
 * - MAL: Direct mapping via getMappingByMalId → AniList ID
 * 
 * @param {ParsedMediaId} parsedId - Parsed media identifier
 * @returns {Promise<{anilistId: number, episode: number}|null>} AniList ID and episode or null if resolution fails
 */
async function resolveAniListId(parsedId) {
  if (!parsedId || !parsedId.provider || !parsedId.id) {
    logger.warn('[AniList Tracker] Invalid parsedId provided to resolveAniListId');
    return null;
  }

  const provider = parsedId.provider.toLowerCase();
  const id = parsedId.id;

  logger.debug(`[AniList Tracker] Resolving AniList ID for ${provider}:${id}`);

  try {
    let mapping = null;

    switch (provider) {
      case 'imdb': {
        // Handle IMDB IDs: Get TVDB ID from mapping, then use resolveAnidbEpisodeFromTvdbEpisode
        mapping = idMapper.getMappingByImdbId(id);
        if (!mapping) {
          logger.debug(`[AniList Tracker] No mapping found for IMDB ${id}`);
          return null;
        }
        
        const tvdbId = mapping.tvdb_id;
        if (!tvdbId) {
          logger.debug(`[AniList Tracker] No TVDB ID in mapping for IMDB ${id}`);
          return null;
        }
        
        const seasonNumber = parsedId.season || 1;
        const episodeNumber = parsedId.episode || 1;
        
        // Resolve TVDB episode to AniDB episode info
        const anidbEpisodeInfo = await resolveAnidbEpisodeFromTvdbEpisode(tvdbId, seasonNumber, episodeNumber);
        if (!anidbEpisodeInfo) {
          logger.debug(`[AniList Tracker] No AniDB episode info found for TVDB ${tvdbId} S${seasonNumber}E${episodeNumber}`);
          return null;
        }
        
        // Get AniList ID from AniDB ID
        const anidbMapping = idMapper.getMappingByAnidbId(anidbEpisodeInfo.anidbId);
        if (anidbMapping && anidbMapping.anilist_id) {
          logger.debug(`[AniList Tracker] Resolved IMDB ${id} via TVDB ${tvdbId} S${seasonNumber}E${episodeNumber} → AniDB ${anidbEpisodeInfo.anidbId} → AniList ${anidbMapping.anilist_id}, episode ${anidbEpisodeInfo.anidbEpisode}`);
          return { anilistId: anidbMapping.anilist_id, episode: anidbEpisodeInfo.anidbEpisode };
        }
        logger.debug(`[AniList Tracker] No AniList mapping found for AniDB ${anidbEpisodeInfo.anidbId}`);
        return null;
      }

      case 'kitsu': {
        // Handle Kitsu IDs: use getMappingByKitsuId → extract anilist_id
        const kitsuId = parseInt(id, 10);
        mapping = idMapper.getMappingByKitsuId(kitsuId);
        if (mapping && mapping.anilist_id) {
          const episode = parsedId.episode || 1;
          logger.debug(`[AniList Tracker] Resolved Kitsu ${id} to AniList ID ${mapping.anilist_id}, episode ${episode}`);
          return { anilistId: mapping.anilist_id, episode };
        }
        logger.debug(`[AniList Tracker] No AniList mapping found for Kitsu ${id}`);
        return null;
      }

      case 'mal': {
        // Handle MAL IDs: use getMappingByMalId → extract anilist_id
        const malId = parseInt(id, 10);
        mapping = idMapper.getMappingByMalId(malId);
        if (mapping && mapping.anilist_id) {
          const episode = parsedId.episode || 1;
          logger.debug(`[AniList Tracker] Resolved MAL ${id} to AniList ID ${mapping.anilist_id}, episode ${episode}`);
          return { anilistId: mapping.anilist_id, episode };
        }
        logger.debug(`[AniList Tracker] No AniList mapping found for MAL ${id}`);
        return null;
      }

      default:
        logger.debug(`[AniList Tracker] Unsupported ID provider for AniList tracking: ${provider}`);
        return null;
    }
  } catch (error) {
    logger.error(`[AniList Tracker] Error resolving AniList ID for ${provider}:${id}:`, error.message || error);
    return null;
  }
}

/**
 * Check if AniList tracking should be enabled for this request
 * 
 * @param {Object} config - User configuration
 * @returns {boolean} True if tracking should proceed
 */
function shouldTrackAniList(config) {
  // Check if AniList token ID exists (user has connected their account)
  // Token ID is stored in apiKeys.anilistTokenId by the frontend
  if (!config?.apiKeys?.anilistTokenId) {
    logger.debug('[AniList Tracker] Skipped - No AniList account connected');
    return false;
  }

  // Check if anilistWatchTracking is enabled (same pattern as mdblistWatchTracking)
  if (!config.anilistWatchTracking) {
    logger.debug('[AniList Tracker] Skipped - Feature disabled in user config');
    return false;
  }

  logger.debug('[AniList Tracker] Enabled - AniList account connected and tracking enabled');
  return true;
}

/**
 * Main tracking function - tracks anime watch progress on AniList
 * 
 * This function:
 * 1. Checks if AniList tracking is enabled and tokens exist
 * 2. Resolves AniList ID from parsed media ID
 * 3. Gets valid access token (with auto-refresh)
 * 4. Fetches current media status from AniList
 * 5. Compares progress and updates if new episode is higher
 * 6. Logs results for debugging
 * 
 * @param {ParsedMediaId} parsedId - Parsed media identifier
 * @param {Object} config - User configuration
 * @param {string} userUUID - User's UUID for token retrieval
 * @returns {Promise<{success: boolean, reason?: string, updated?: boolean}>}
 */
async function trackAnimeProgress(parsedId, config, userUUID) {
  const startTime = Date.now();
  
  try {
    logger.debug(`[AniList Tracker] trackAnimeProgress called for ${parsedId?.provider}:${parsedId?.id}`);

    // Step 1: Check if AniList tracking is enabled and tokens exist
    if (!shouldTrackAniList(config)) {
      return { success: true, reason: 'tracking_disabled', updated: false };
    }

    // Validate parsedId has required fields
    if (!parsedId || !parsedId.provider || !parsedId.id) {
      logger.warn('[AniList Tracker] Invalid parsedId - missing required fields');
      return { success: false, reason: 'invalid_parsed_id', updated: false };
    }

    // For series, we need an episode number
    if (parsedId.type === 'series' && (!parsedId.episode || parsedId.episode < 1)) {
      logger.warn(`[AniList Tracker] Invalid episode number for series: ${parsedId.episode}`);
      return { success: false, reason: 'invalid_episode', updated: false };
    }

    // Step 2: Resolve AniList ID and episode from parsed media ID
    const resolution = await resolveAniListId(parsedId);
    if (!resolution) {
      logger.debug(`[AniList Tracker] Could not resolve AniList ID for ${parsedId.provider}:${parsedId.id}`);
      return { success: true, reason: 'id_not_resolved', updated: false };
    }

    const { anilistId, episode: episodeNumber } = resolution;
    logger.debug(`[AniList Tracker] Resolved ${parsedId.provider}:${parsedId.id} to AniList ID ${anilistId}, episode ${episodeNumber}`);

    // Step 3: Get valid access token (with auto-refresh)
    const accessToken = await getValidAccessToken(userUUID);
    if (!accessToken) {
      logger.warn(`[AniList Tracker] No valid access token available for user ${userUUID}`);
      return { success: false, reason: 'no_valid_token', updated: false };
    }

    // Step 4: Fetch current media status from AniList
    const mediaStatus = await getMediaStatus(anilistId, accessToken);
    if (!mediaStatus) {
      // Media might not exist on AniList - this is not an error
      logger.debug(`[AniList Tracker] Could not fetch media status for AniList ID ${anilistId}`);
      return { success: true, reason: 'media_not_found', updated: false };
    }

    // Step 5: Compare progress and update if new episode is higher
    const currentProgress = mediaStatus.mediaListEntry?.progress || 0;
    const totalEpisodes = mediaStatus.episodes;

    logger.debug(`[AniList Tracker] Current progress: ${currentProgress}, New episode: ${episodeNumber}, Total: ${totalEpisodes || 'unknown'}`);

    // Only update if the new episode is greater than current progress
    if (episodeNumber <= currentProgress) {
      logger.debug(`[AniList Tracker] Skipping update - episode ${episodeNumber} not greater than current progress ${currentProgress}`);
      return { success: true, reason: 'no_progress_change', updated: false };
    }

    // Step 6: Update progress on AniList
    const updateSuccess = await updateProgress(anilistId, episodeNumber, totalEpisodes, accessToken);
    
    const elapsed = Date.now() - startTime;
    
    if (updateSuccess) {
      logger.info(`[AniList Tracker] Successfully updated AniList ID ${anilistId} to episode ${episodeNumber} (took ${elapsed}ms)`);
      return { success: true, reason: 'updated', updated: true };
    } else {
      logger.warn(`[AniList Tracker] Failed to update progress for AniList ID ${anilistId}`);
      return { success: false, reason: 'update_failed', updated: false };
    }

  } catch (error) {
    const elapsed = Date.now() - startTime;
    logger.error(`[AniList Tracker] Error tracking progress (took ${elapsed}ms):`, error.message || error);
    return { success: false, reason: 'error', updated: false };
  }
}

/**
 * Generate the AniList OAuth authorization URL
 * 
 * @param {string} redirectUri - OAuth callback URL
 * @param {string} state - CSRF protection state parameter
 * @returns {string} Authorization URL
 */
function getAuthorizationUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: ANILIST_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: state
  });
  return `${ANILIST_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for OAuth tokens
 * 
 * Uses retry logic with exponential backoff for rate limits and server errors.
 * 
 * @param {string} code - Authorization code from OAuth callback
 * @param {string} redirectUri - OAuth callback URL (must match authorization request)
 * @returns {Promise<Object|null>} Token response or null on failure
 */
async function exchangeCodeForTokens(code, redirectUri) {
  try {
    if (!ANILIST_CLIENT_ID || !ANILIST_CLIENT_SECRET) {
      logger.error('[AniList Tracker] Missing ANILIST_CLIENT_ID or ANILIST_CLIENT_SECRET environment variables');
      return null;
    }

    logger.debug('[AniList Tracker] Exchanging authorization code for tokens');

    // Use retry logic for token exchange
    const response = await makeRateLimitedRequest(() =>
      httpPost(ANILIST_TOKEN_URL, {
        grant_type: 'authorization_code',
        client_id: ANILIST_CLIENT_ID,
        client_secret: ANILIST_CLIENT_SECRET,
        redirect_uri: redirectUri,
        code: code
      }, {
        timeout: REQUEST_TIMEOUT_MS
      })
    );

    const data = response.data;

    if (!data || !data.access_token) {
      logger.error('[AniList Tracker] Invalid response from token exchange endpoint');
      return null;
    }

    // Calculate expiration timestamp
    const expiresAt = Date.now() + (data.expires_in * 1000);

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || '',
      expires_at: expiresAt,
      token_type: data.token_type
    };
  } catch (error) {
    const errorDetails = extractErrorDetails(error);
    logger.error(`[AniList Tracker] Token exchange failed: ${errorDetails.message} (status: ${errorDetails.status || 'N/A'})`);
    return null;
  }
}

/**
 * Get the authenticated user's AniList profile
 * 
 * Uses retry logic with exponential backoff for rate limits and server errors.
 * 
 * @param {string} accessToken - Valid OAuth access token
 * @returns {Promise<Object|null>} User profile or null on failure
 */
async function getAuthenticatedUser(accessToken) {
  try {
    const query = `
      query {
        Viewer {
          id
          name
        }
      }
    `;

    // Use retry logic for user profile fetch
    const response = await makeRateLimitedRequest(() =>
      httpPost(ANILIST_GRAPHQL_URL, {
        query: query
      }, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: REQUEST_TIMEOUT_MS
      })
    );

    const data = response.data;

    // Handle GraphQL errors using enhanced error parsing
    const graphqlErrors = parseGraphQLErrors(data);
    if (graphqlErrors.hasErrors) {
      const errorMessages = graphqlErrors.errors.map(e => e.message).join(', ');
      logger.error(`[AniList Tracker] GraphQL error getting user: ${errorMessages}`);
      return null;
    }

    if (!data.data || !data.data.Viewer) {
      logger.error('[AniList Tracker] Invalid response getting user');
      return null;
    }

    return {
      id: data.data.Viewer.id,
      username: data.data.Viewer.name
    };
  } catch (error) {
    const errorDetails = extractErrorDetails(error);
    logger.error(`[AniList Tracker] Failed to get authenticated user: ${errorDetails.message} (status: ${errorDetails.status || 'N/A'})`);
    return null;
  }
}

// Export module functions
module.exports = {
  // Token management
  isTokenExpired,
  getValidAccessToken,
  
  // OAuth flow
  getAuthorizationUrl,
  exchangeCodeForTokens,
  getAuthenticatedUser,
  
  // AniList operations
  getMediaStatus,
  updateProgress,
  resolveAniListId,
  determineStatus,
  
  // Main tracking function
  trackAnimeProgress,
  shouldTrackAniList,
  
  // Internal utilities (exported for testing)
  makeRateLimitedRequest,
  isRetryableError,
  extractErrorDetails,
  parseGraphQLErrors,
  
  // Constants (for testing)
  TOKEN_EXPIRATION_BUFFER_MS,
  REQUEST_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_DELAYS,
  ANILIST_GRAPHQL_URL,
  ANILIST_AUTH_URL,
  ANILIST_TOKEN_URL
};
