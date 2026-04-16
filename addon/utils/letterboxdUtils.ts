
import { httpGet, httpHead, createDispatcher } from "./httpClient.js";
import { cacheWrapMetaSmart } from "../lib/getCache.js";
import { getMeta } from "../lib/getMeta.js";
import { UserConfig } from "../types/index.js";
const consola = require('consola');
const buildInfo = require('../lib/buildInfo');

const logger = consola.withTag('Letterboxd');

const letterboxdDispatcher = createDispatcher({
  label: 'Letterboxd',
  proxyEnvVars: [],
  agentOptions: { connect: { timeout: 30_000 } },
});

// Rate limiting configuration for Letterboxd API (through StremThru)
const RATE_LIMIT_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  minInterval: 500,
  backoffMultiplier: 2
};

let rateLimitState = {
  lastRequestTime: 0,
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limited request wrapper
 * Tracks provider calls only for final outcomes (not each retry attempt)
 */
async function makeRateLimitedRequest<T>(
  requestFn: () => Promise<T>,
  context: string = 'Letterboxd',
  retries: number = RATE_LIMIT_CONFIG.maxRetries
): Promise<T> {
  let attempt = 0;
  const overallStartTime = Date.now(); // Track total time including retries

  while (attempt < retries) {
    attempt++;
    const isLastAttempt = attempt === retries;
    const now = Date.now();

    // Enforce minimum interval between requests
    const timeSinceLastRequest = now - rateLimitState.lastRequestTime;
    if (timeSinceLastRequest < RATE_LIMIT_CONFIG.minInterval) {
      const waitTime = RATE_LIMIT_CONFIG.minInterval - timeSinceLastRequest;
      await sleep(waitTime);
    }

    rateLimitState.lastRequestTime = Date.now();
    const startTime = Date.now();

    try {
      const response = await requestFn();
      const responseTime = Date.now() - startTime;

      // Track success only once on first successful attempt
      const requestTracker = require('../lib/requestTracker.js');
      requestTracker.trackProviderCall('letterboxd', responseTime, true);

      return response;
    } catch (error: any) {
      // Only track failure on final attempt
      if (isLastAttempt) {
        const responseTime = Date.now() - overallStartTime;
        const requestTracker = require('../lib/requestTracker.js');
        requestTracker.trackProviderCall('letterboxd', responseTime, false);

        const status = error.response?.status;
        const errorType = status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'api_error';
        requestTracker.logProviderError('letterboxd', errorType, error.message, {
          context,
          responseTime,
          status,
          attempts: attempt
        });
        
        logger.error(`Request failed after ${retries} attempts: ${error.message} - ${context}`);
        throw error;
      }

      // Log rate limits even on non-final attempts (but don't track as failure)
      if (error.response?.status === 429) {
        const requestTracker = require('../lib/requestTracker.js');
        requestTracker.logProviderError('letterboxd', 'rate_limit', 'Rate limit hit (429)', {
          context,
          responseTime: Date.now() - startTime,
          attempt,
          retriesRemaining: retries - attempt
        });
      }

      const delay = Math.min(
        RATE_LIMIT_CONFIG.baseDelay * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt - 1),
        RATE_LIMIT_CONFIG.maxDelay
      );

      logger.debug(`Attempt ${attempt} failed, retrying in ${delay}ms - ${context}`);
      await sleep(delay);
    }
  }

  throw new Error(`[${context}] All ${retries} attempts failed.`);
}

/**
 * Extract x-letterboxd-identifier from a Letterboxd URL
 * @param url - Letterboxd URL (list or watchlist)
 * @returns x-letterboxd-identifier string
 */
export async function extractLetterboxdIdentifier(url: string): Promise<string> {
  try {
    logger.info(`Extracting identifier from URL: ${url}`);
    
    // Parse URL to check if it's a watchlist
    const urlObj = new URL(url);
    const isWatchlist = urlObj.pathname.includes('/watchlist');
    
    // If watchlist, strip to user profile URL
    let requestUrl = url;
    if (isWatchlist) {
      // Extract username from URL like https://letterboxd.com/dave/watchlist/
      const pathParts = urlObj.pathname.split('/').filter(Boolean);
      if (pathParts.length >= 1) {
        const username = pathParts[0];
        requestUrl = `https://letterboxd.com/${username}/`;
        logger.info(`Detected watchlist, using profile URL: ${requestUrl}`);
      }
    }

    // Make HEAD request to extract identifier from headers
    const response: any = await makeRateLimitedRequest(
      () => httpHead(requestUrl, {
        dispatcher: letterboxdDispatcher,
        headers: {
          'User-Agent': `AIOMetadata/${buildInfo.version}`,
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }),
      `Letterboxd extractIdentifier (${requestUrl})`
    );

    //consola.debug(`[Letterboxd] Response headers:`, response.headers);
    
    // Extract x-letterboxd-identifier from response headers
    const identifier = response.headers?.['x-letterboxd-identifier'];
    
    if (!identifier) {
      throw new Error('x-letterboxd-identifier not found in response headers');
    }

    logger.info(`Successfully extracted identifier: ${identifier}`);
    return identifier;
  } catch (error: any) {
    logger.error(`Failed to extract Letterboxd identifier: ${error.message}`);
    throw error;
  }
}

/**
 * Fetch Letterboxd list items from StremThru API
 * @param identifier - x-letterboxd-identifier
 * @param isWatchlist - Whether this is a watchlist
 * @returns List data with items
 */
export async function fetchLetterboxdList(
  identifier: string,
  isWatchlist: boolean = false
): Promise<any> {
  try {
    let url: string;
    
    if (isWatchlist) {
      url = `https://stremthru.13377001.xyz/v0/meta/letterboxd/users/${identifier}/lists/watchlist`;
      logger.info(`Fetching watchlist from StremThru: ${url}`);
    } else {
      url = `https://stremthru.13377001.xyz/v0/meta/letterboxd/lists/${identifier}`;
      logger.info(`Fetching list from StremThru: ${url}`);
    }

    const response: any = await makeRateLimitedRequest(
      () => httpGet(url, {
        dispatcher: letterboxdDispatcher,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'AIOMetadata/1.0'
        }
      }),
      `Letterboxd fetchList (${identifier})`
    );

    const data = response.data;
    
    if (!data) {
      throw new Error('Invalid response from StremThru API');
    }

    logger.info(`Successfully fetched Letterboxd list: ${data.data?.title || identifier} (${data.data?.items?.length || 0} items)`);
    
    return data;
  } catch (error: any) {
    logger.error(`Failed to fetch Letterboxd list: ${error.message}`);
    throw error;
  }
}

/**
 * Parse Letterboxd items and convert to Stremio meta format
 * @param items - Array of Letterboxd items from StremThru
 * @param type - Catalog type filter
 * @param language - Language code
 * @param config - User configuration
 * @param includeVideos - Whether to include video data
 * @returns Array of Stremio meta objects
 */
export async function parseLetterboxdItems(
  items: any[],
  type: string,
  language: string,
  config: UserConfig,
  includeVideos: boolean = false
): Promise<any[]> {
  const parseStart = Date.now();

  logger.info(`Parsing ${items.length} Letterboxd items (type: ${type})`);

  const metas = await Promise.all(
    items.map(async (item: any) => {
      try {
        // Extract IDs from id_map
        const idMap = item.id_map || {};
        const imdbId = idMap.imdb;
        const tmdbId = idMap.tmdb;
        const malId = idMap.anime?.mal; // For anime titles

        if (!imdbId && !tmdbId && !malId) {
          logger.warn(`Letterboxd item missing both IMDB, TMDB and MAL IDs: ${item.title}`);
          return null;
        }

        // Prefer IMDB ID, fallback to TMDB
        const stremioId = imdbId || `tmdb:${tmdbId}` || `mal:${malId}`;
        const itemType = item.type === 'show' ? 'series' : 'movie';


        const result = await cacheWrapMetaSmart(
          config.userUUID,
          stremioId,
          async () => {
            return await getMeta(itemType, language, stremioId, config, config.userUUID, includeVideos);
          },
          undefined,
          { enableErrorCaching: true, maxRetries: 2 },
          itemType as any,
          includeVideos
        );

        if (result && result.meta) {
          return result.meta;
        }
        return null;
      } catch (error: any) {
        logger.error(`Error getting meta for Letterboxd item: ${error.message}`);
        return null;
      }
    })
  );

  const validMetas = metas.filter(Boolean);
  const totalParseTime = Date.now() - parseStart;

  logger.info(`Successfully parsed ${validMetas.length}/${items.length} Letterboxd items in ${totalParseTime}ms`);

  return validMetas;
}

/**
 * Validate and parse a Letterboxd URL
 * @param url - Letterboxd URL to validate
 * @returns Object with validation result and parsed data
 */
export function validateLetterboxdUrl(url: string): {
  valid: boolean;
  isWatchlist: boolean;
  username?: string;
  listSlug?: string;
  error?: string;
} {
  try {
    const urlObj = new URL(url);

    // Must be from letterboxd.com
    if (!urlObj.hostname.includes('letterboxd.com')) {
      return { valid: false, isWatchlist: false, error: 'Not a Letterboxd URL' };
    }

    const pathParts = urlObj.pathname.split('/').filter(Boolean);

    // Check if it's a watchlist: https://letterboxd.com/dave/watchlist/
    if (pathParts.length >= 2 && pathParts[1] === 'watchlist') {
      return {
        valid: true,
        isWatchlist: true,
        username: pathParts[0]
      };
    }

    // Check if it's a regular list: https://letterboxd.com/dave/list/list-name/
    if (pathParts.length >= 3 && pathParts[1] === 'list') {
      return {
        valid: true,
        isWatchlist: false,
        username: pathParts[0],
        listSlug: pathParts.slice(2).join('/')
      };
    }

    return { valid: false, isWatchlist: false, error: 'Invalid Letterboxd URL format' };
  } catch (error: any) {
    return { valid: false, isWatchlist: false, error: 'Invalid URL' };
  }
}
/**
 * Get Letterboxd genre name from genre ID
 * @param genreId - Letterboxd genre ID
 * @returns Letterboxd genre name or null if not found
 */
export function getLetterboxdGenreIdByName(name: string): string | null {
    const genreNameById = {
      "8G":  "Action",
      "9k":  "Adventure",
      "8m":  "Animation",
      "7I":  "Comedy",
      "9Y":  "Crime",
      "ai":  "Documentary",
      "7S":  "Drama",
      "8w":  "Family",
      "82":  "Fantasy",
      "90":  "History",
      "aC":  "Horror",
      "b6":  "Music",
      "aW":  "Mystery",
      "8c":  "Romance",
      "9a":  "Science Fiction",
      "a8":  "Thriller",
      "1hO": "TV Movie",
      "9u":  "War",
      "8Q":  "Western",
    };
  
    const entry = Object.entries(genreNameById)
      .find(([_, value]) => value === name);
  
    return entry ? entry[0] : null;
  }
  
export {
  makeRateLimitedRequest
};

