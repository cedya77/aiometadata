/**
 * MyAnimeList Watch Tracking Module
 *
 * Provides functionality to automatically sync anime watch progress to MyAnimeList.
 * Uses the existing OAuth token storage infrastructure and anime ID mapping system.
 *
 * @module malTracker
 */

import consola from 'consola';
import crypto from 'crypto';
import { request } from 'undici';

const database: any = require('./database');
const idMapper: any = require('./id-mapper');
const { resolveAnidbEpisodeFromTvdbEpisode } = require('./anime-list-mapper');

const logger = consola.withTag('MALTracker');

const MAL_API_BASE = 'https://api.myanimelist.net/v2';
const MAL_AUTH_URL = 'https://myanimelist.net/v1/oauth2/authorize';
const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';

const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID;
const MAL_CLIENT_SECRET = process.env.MAL_CLIENT_SECRET;

const TOKEN_EXPIRATION_BUFFER_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

type MalListStatus = 'watching' | 'completed' | 'on_hold' | 'dropped' | 'plan_to_watch';

interface ParsedMediaId {
  type: string;
  provider: string;
  id: string;
  season?: number;
  episode?: number;
}

interface MalTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface MalAnimeStatus {
  episodes: number | null;
  listStatus: {
    status: MalListStatus;
    num_episodes_watched: number;
    score: number;
  } | null;
}

function isRetryableError(error: any): boolean {
  const status = error?.response?.status;
  return status === 429 || (status >= 500 && status < 600);
}

async function makeRateLimitedRequest<T>(requestFn: () => Promise<T>, maxRetries: number = MAX_RETRIES): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await requestFn();
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries && isRetryableError(error)) {
        const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        logger.debug(`[MAL Tracker] Retryable error (status ${error?.response?.status}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function malRequest(url: string, options: { method?: string; form?: Record<string, string>; accessToken?: string } = {}): Promise<any> {
  const { method = 'GET', form, accessToken } = options;

  const headers: Record<string, string> = {
    'Accept': 'application/json'
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  } else if (MAL_CLIENT_ID) {
    headers['X-MAL-CLIENT-ID'] = MAL_CLIENT_ID;
  }

  let body: string | undefined;
  if (form) {
    body = new URLSearchParams(form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  const { statusCode, body: responseBody } = await request(url, {
    method: method as any,
    headers,
    body,
    bodyTimeout: REQUEST_TIMEOUT_MS,
    headersTimeout: REQUEST_TIMEOUT_MS
  });

  const text = await responseBody.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (statusCode < 200 || statusCode >= 300) {
    const error: any = new Error(`MAL request failed with status ${statusCode}`);
    error.response = { status: statusCode, data };
    throw error;
  }

  return data;
}

function isTokenExpired(expiresAt: any): boolean {
  const numericExpiry = Number(expiresAt);
  if (!Number.isFinite(numericExpiry) || numericExpiry <= 0) {
    return true;
  }
  return Date.now() >= (numericExpiry - TOKEN_EXPIRATION_BUFFER_MS);
}

/**
 * Generate a PKCE code verifier. MAL only supports the "plain" challenge
 * method, so the challenge equals the verifier.
 */
function generateCodeVerifier(): string {
  return crypto.randomBytes(64).toString('base64url');
}

function getAuthorizationUrl(redirectUri: string, state: string, codeVerifier: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: MAL_CLIENT_ID || '',
    state,
    redirect_uri: redirectUri,
    code_challenge: codeVerifier,
    code_challenge_method: 'plain'
  });
  return `${MAL_AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code: string, redirectUri: string, codeVerifier: string): Promise<MalTokens | null> {
  try {
    if (!MAL_CLIENT_ID || !MAL_CLIENT_SECRET) {
      logger.error('[MAL Tracker] Missing MAL_CLIENT_ID or MAL_CLIENT_SECRET environment variables');
      return null;
    }

    const data = await makeRateLimitedRequest(() =>
      malRequest(MAL_TOKEN_URL, {
        method: 'POST',
        form: {
          client_id: MAL_CLIENT_ID,
          client_secret: MAL_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier
        }
      })
    );

    if (!data || !data.access_token) {
      logger.error('[MAL Tracker] Invalid response from token exchange endpoint');
      return null;
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || '',
      expires_at: Date.now() + (data.expires_in * 1000)
    };
  } catch (error: any) {
    logger.error(`[MAL Tracker] Token exchange failed: ${error.message} (status: ${error?.response?.status || 'N/A'})`, error?.response?.data);
    return null;
  }
}

async function refreshAccessToken(refreshToken: string): Promise<MalTokens | null> {
  try {
    if (!MAL_CLIENT_ID || !MAL_CLIENT_SECRET) {
      logger.error('[MAL Tracker] Missing MAL_CLIENT_ID or MAL_CLIENT_SECRET environment variables');
      return null;
    }

    const data = await makeRateLimitedRequest(() =>
      malRequest(MAL_TOKEN_URL, {
        method: 'POST',
        form: {
          client_id: MAL_CLIENT_ID,
          client_secret: MAL_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        }
      })
    );

    if (!data || !data.access_token) {
      logger.error('[MAL Tracker] Invalid response from token refresh endpoint');
      return null;
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_at: Date.now() + (data.expires_in * 1000)
    };
  } catch (error: any) {
    logger.error(`[MAL Tracker] Token refresh failed: ${error.message} (status: ${error?.response?.status || 'N/A'})`);
    return null;
  }
}

async function getAuthenticatedUser(accessToken: string): Promise<{ id: number; username: string } | null> {
  try {
    const data = await makeRateLimitedRequest(() =>
      malRequest(`${MAL_API_BASE}/users/@me`, { accessToken })
    );

    if (!data || !data.name) {
      logger.error('[MAL Tracker] Invalid response getting user profile');
      return null;
    }

    return { id: data.id, username: data.name };
  } catch (error: any) {
    logger.error(`[MAL Tracker] Failed to get authenticated user: ${error.message} (status: ${error?.response?.status || 'N/A'})`);
    return null;
  }
}

const MAL_USERLIST_STATUSES = ['watching', 'completed', 'on_hold', 'dropped', 'plan_to_watch'];
const MAL_USERLIST_SORTS = ['list_updated_at', 'list_score', 'anime_title', 'anime_start_date'];

/**
 * Fetch the authenticated user's anime list filtered by status
 */
async function fetchMalUserList(
  status: string,
  accessToken: string,
  offset: number = 0,
  limit: number = 20,
  sort: string = 'list_updated_at',
  nsfw: boolean = true
): Promise<{ items: any[]; hasMore: boolean }> {
  const effectiveSort = MAL_USERLIST_SORTS.includes(sort) ? sort : 'list_updated_at';
  const fields = 'list_status,num_episodes,media_type,start_date,end_date,synopsis,alternative_titles,average_episode_duration,main_picture';
  const params = new URLSearchParams({
    status,
    sort: effectiveSort,
    limit: String(limit),
    offset: String(offset),
    fields
  });
  if (nsfw) {
    params.set('nsfw', 'true');
  }

  const data = await makeRateLimitedRequest(() =>
    malRequest(`${MAL_API_BASE}/users/@me/animelist?${params.toString()}`, { accessToken })
  );

  return {
    items: Array.isArray(data?.data) ? data.data : [],
    hasMore: !!data?.paging?.next
  };
}

/**
 * Fetch MAL's personalized anime suggestions for the authenticated user
 */
async function fetchMalSuggestions(
  accessToken: string,
  offset: number = 0,
  limit: number = 20,
  nsfw: boolean = true
): Promise<{ items: any[]; hasMore: boolean }> {
  const fields = 'num_episodes,media_type,start_date,end_date,synopsis,alternative_titles,average_episode_duration,main_picture';
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    fields
  });
  if (nsfw) {
    params.set('nsfw', 'true');
  }

  const data = await makeRateLimitedRequest(() =>
    malRequest(`${MAL_API_BASE}/anime/suggestions?${params.toString()}`, { accessToken })
  );

  return {
    items: Array.isArray(data?.data) ? data.data : [],
    hasMore: !!data?.paging?.next
  };
}

const refreshLocks = new Map<string, Promise<string | null>>();

/**
 * Get a valid access token for a user, refreshing if necessary
 */
async function getValidAccessToken(userUUID: string): Promise<string | null> {
  try {
    const config = await database.getUserConfig(userUUID);
    const malTokenId = config?.apiKeys?.malTokenId;
    if (!config || !malTokenId) {
      logger.debug(`[MAL Tracker] No MAL token ID found for user ${userUUID}`);
      return null;
    }

    const tokenData = await database.getOAuthToken(malTokenId);
    if (!tokenData) {
      logger.debug(`[MAL Tracker] No OAuth token found for token ID ${malTokenId}`);
      return null;
    }

    if (!isTokenExpired(tokenData.expires_at)) {
      return tokenData.access_token;
    }

    if (!tokenData.refresh_token) {
      logger.warn(`[MAL Tracker] Token expired for user ${userUUID} and no refresh token available. User must re-authenticate.`);
      return null;
    }

    if (refreshLocks.has(malTokenId)) {
      return refreshLocks.get(malTokenId)!;
    }

    const refreshPromise = (async (): Promise<string | null> => {
      logger.info(`[MAL Tracker] Access token expired for token ${malTokenId}, refreshing`);
      const refreshed = await refreshAccessToken(tokenData.refresh_token);
      if (!refreshed) {
        logger.warn(`[MAL Tracker] Token refresh failed for ${malTokenId}. User must re-authenticate.`);
        return null;
      }
      await database.updateOAuthToken(malTokenId, refreshed.access_token, refreshed.refresh_token, refreshed.expires_at);
      return refreshed.access_token;
    })();

    refreshLocks.set(malTokenId, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      refreshLocks.delete(malTokenId);
    }
  } catch (error: any) {
    logger.error(`[MAL Tracker] Error getting valid access token for user ${userUUID}:`, error.message || error);
    return null;
  }
}

/**
 * Resolve a MAL ID and per-entry episode number from a parsed media ID
 */
async function resolveMalId(parsedId: ParsedMediaId): Promise<{ malId: number; episode: number } | null> {
  if (!parsedId || !parsedId.provider || !parsedId.id) {
    logger.warn('[MAL Tracker] Invalid parsedId provided to resolveMalId');
    return null;
  }

  const provider = parsedId.provider.toLowerCase();
  const id = parsedId.id;

  logger.debug(`[MAL Tracker] Resolving MAL ID for ${provider}:${id}`);

  try {
    switch (provider) {
      case 'imdb': {
        const mapping = idMapper.getMappingByImdbId(id);
        if (!mapping) {
          logger.debug(`[MAL Tracker] No mapping found for IMDB ${id}`);
          return null;
        }

        const tvdbId = mapping.tvdb_id;
        if (!tvdbId) {
          logger.debug(`[MAL Tracker] No TVDB ID in mapping for IMDB ${id}`);
          return null;
        }

        const seasonNumber = parsedId.season || 1;
        const episodeNumber = parsedId.episode || 1;

        const anidbEpisodeInfo = await resolveAnidbEpisodeFromTvdbEpisode(tvdbId, seasonNumber, episodeNumber);
        if (!anidbEpisodeInfo) {
          logger.debug(`[MAL Tracker] No AniDB episode info found for TVDB ${tvdbId} S${seasonNumber}E${episodeNumber}`);
          return null;
        }

        const anidbMapping = idMapper.getMappingByAnidbId(anidbEpisodeInfo.anidbId);
        if (anidbMapping && anidbMapping.mal_id) {
          logger.debug(`[MAL Tracker] Resolved IMDB ${id} via TVDB ${tvdbId} S${seasonNumber}E${episodeNumber} → AniDB ${anidbEpisodeInfo.anidbId} → MAL ${anidbMapping.mal_id}, episode ${anidbEpisodeInfo.anidbEpisode}`);
          return { malId: anidbMapping.mal_id, episode: anidbEpisodeInfo.anidbEpisode };
        }
        logger.debug(`[MAL Tracker] No MAL mapping found for AniDB ${anidbEpisodeInfo.anidbId}`);
        return null;
      }

      case 'kitsu': {
        const kitsuId = parseInt(id, 10);
        const mapping = idMapper.getMappingByKitsuId(kitsuId);
        if (mapping && mapping.mal_id) {
          const episode = parsedId.episode || 1;
          logger.debug(`[MAL Tracker] Resolved Kitsu ${id} to MAL ID ${mapping.mal_id}, episode ${episode}`);
          return { malId: mapping.mal_id, episode };
        }
        logger.debug(`[MAL Tracker] No MAL mapping found for Kitsu ${id}`);
        return null;
      }

      case 'mal': {
        const malId = parseInt(id, 10);
        if (Number.isNaN(malId) || malId <= 0) {
          return null;
        }
        const episode = parsedId.episode || 1;
        return { malId, episode };
      }

      default:
        logger.debug(`[MAL Tracker] Unsupported ID provider for MAL tracking: ${provider}`);
        return null;
    }
  } catch (error: any) {
    logger.error(`[MAL Tracker] Error resolving MAL ID for ${provider}:${id}:`, error.message || error);
    return null;
  }
}

/**
 * Fetch the anime's episode count and the user's current list status
 */
async function getAnimeStatus(malId: number, accessToken: string): Promise<MalAnimeStatus | null> {
  try {
    const data = await makeRateLimitedRequest(() =>
      malRequest(`${MAL_API_BASE}/anime/${malId}?fields=id,num_episodes,my_list_status{status,num_episodes_watched,score}`, { accessToken })
    );

    if (!data || !data.id) {
      return null;
    }

    return {
      episodes: data.num_episodes || null,
      listStatus: data.my_list_status || null
    };
  } catch (error: any) {
    if (error?.response?.status === 404) {
      logger.debug(`[MAL Tracker] Anime ${malId} not found on MAL`);
      return null;
    }
    logger.error(`[MAL Tracker] Failed to fetch anime status for MAL ID ${malId}: ${error.message} (status: ${error?.response?.status || 'N/A'})`);
    return null;
  }
}

function determineStatus(episode: number, totalEpisodes: number | null): MalListStatus {
  if (totalEpisodes && totalEpisodes > 0 && episode >= totalEpisodes) {
    return 'completed';
  }
  return 'watching';
}

/**
 * Update watch progress on MAL. The PATCH endpoint creates the list entry
 * if the anime is not on the user's list yet.
 */
async function updateProgress(malId: number, episode: number, totalEpisodes: number | null, accessToken: string): Promise<boolean> {
  try {
    const status = determineStatus(episode, totalEpisodes);
    const form: Record<string, string> = {
      status,
      num_watched_episodes: String(episode)
    };

    await makeRateLimitedRequest(() =>
      malRequest(`${MAL_API_BASE}/anime/${malId}/my_list_status`, {
        method: 'PATCH',
        form,
        accessToken
      })
    );

    logger.debug(`[MAL Tracker] Updated MAL ID ${malId} to episode ${episode}, status ${status}`);
    return true;
  } catch (error: any) {
    logger.error(`[MAL Tracker] Failed to update progress for MAL ID ${malId}: ${error.message} (status: ${error?.response?.status || 'N/A'})`);
    return false;
  }
}

/**
 * Check if MAL tracking should be enabled for this request
 */
function shouldTrackMal(config: any): boolean {
  if (!config?.apiKeys?.malTokenId) {
    logger.debug('[MAL Tracker] Skipped - No MAL account connected');
    return false;
  }

  if (!config.malWatchTracking) {
    logger.debug('[MAL Tracker] Skipped - Feature disabled in user config');
    return false;
  }

  return true;
}

/**
 * Main tracking function - tracks anime watch progress on MAL
 */
async function trackAnimeProgress(parsedId: ParsedMediaId, config: any, userUUID: string): Promise<{ success: boolean; reason?: string; updated?: boolean }> {
  const startTime = Date.now();

  try {
    logger.debug(`[MAL Tracker] trackAnimeProgress called for ${parsedId?.provider}:${parsedId?.id}`);

    if (!shouldTrackMal(config)) {
      return { success: true, reason: 'tracking_disabled', updated: false };
    }

    if (!parsedId || !parsedId.provider || !parsedId.id) {
      logger.warn('[MAL Tracker] Invalid parsedId - missing required fields');
      return { success: false, reason: 'invalid_parsed_id', updated: false };
    }

    if (parsedId.type === 'series' && (!parsedId.episode || parsedId.episode < 1)) {
      logger.warn(`[MAL Tracker] Invalid episode number for series: ${parsedId.episode}`);
      return { success: false, reason: 'invalid_episode', updated: false };
    }

    const resolution = await resolveMalId(parsedId);
    if (!resolution) {
      logger.debug(`[MAL Tracker] Could not resolve MAL ID for ${parsedId.provider}:${parsedId.id}`);
      return { success: true, reason: 'id_not_resolved', updated: false };
    }

    const { malId, episode: episodeNumber } = resolution;
    logger.debug(`[MAL Tracker] Resolved ${parsedId.provider}:${parsedId.id} to MAL ID ${malId}, episode ${episodeNumber}`);

    const accessToken = await getValidAccessToken(userUUID);
    if (!accessToken) {
      logger.warn(`[MAL Tracker] No valid access token available for user ${userUUID}`);
      return { success: false, reason: 'no_valid_token', updated: false };
    }

    const animeStatus = await getAnimeStatus(malId, accessToken);
    if (!animeStatus) {
      logger.debug(`[MAL Tracker] Could not fetch anime status for MAL ID ${malId}`);
      return { success: true, reason: 'media_not_found', updated: false };
    }

    const currentProgress = animeStatus.listStatus?.num_episodes_watched || 0;
    const totalEpisodes = animeStatus.episodes;

    logger.debug(`[MAL Tracker] Current progress: ${currentProgress}, New episode: ${episodeNumber}, Total: ${totalEpisodes || 'unknown'}`);

    if (episodeNumber <= currentProgress) {
      logger.debug(`[MAL Tracker] Skipping update - episode ${episodeNumber} not greater than current progress ${currentProgress}`);
      return { success: true, reason: 'no_progress_change', updated: false };
    }

    const updateSuccess = await updateProgress(malId, episodeNumber, totalEpisodes, accessToken);

    const elapsed = Date.now() - startTime;

    if (updateSuccess) {
      logger.info(`[MAL Tracker] Successfully updated MAL ID ${malId} to episode ${episodeNumber} (took ${elapsed}ms)`);
      return { success: true, reason: 'updated', updated: true };
    } else {
      logger.warn(`[MAL Tracker] Failed to update progress for MAL ID ${malId}`);
      return { success: false, reason: 'update_failed', updated: false };
    }
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    logger.error(`[MAL Tracker] Error tracking progress (took ${elapsed}ms):`, error.message || error);
    return { success: false, reason: 'error', updated: false };
  }
}

export {
  isTokenExpired,
  getValidAccessToken,
  fetchMalUserList,
  fetchMalSuggestions,
  MAL_USERLIST_STATUSES,
  generateCodeVerifier,
  getAuthorizationUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  getAuthenticatedUser,
  resolveMalId,
  getAnimeStatus,
  determineStatus,
  updateProgress,
  shouldTrackMal,
  trackAnimeProgress
};
