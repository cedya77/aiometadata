import { httpGet, httpPost } from "./httpClient.js";
import { resolveAllIds } from "../lib/id-resolver.js";
import * as Utils from "./parseProps.js";
import * as moviedb from "../lib/getTmdb.js";
import { getMeta } from "../lib/getMeta.js";
import { cacheWrapMetaSmart } from "../lib/getCache.js";
import { UserConfig } from "../types/index.js";

const host = process.env.HOST_NAME?.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

// Rate limiting configuration for MDBList API
const RATE_LIMIT_CONFIG = {
  maxRetries: 5,
  baseDelay: 1000, // 1 second base delay
  maxDelay: 30000, // 30 seconds max delay
  rateLimitDelay: 5000, // 5 seconds for rate limit backoff
  minInterval: 200, // Minimum 200ms between requests
  backoffMultiplier: 2
};

// Rate limiting state
let rateLimitState = {
  lastRequestTime: 0,
  recentRateLimitHits: 0,
  lastRateLimitTime: 0,
  isRateLimited: false,
  rateLimitResetTime: 0
};

/**
 * Sleep function for delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is a rate limit error
 */
function isRateLimitError(error: any): boolean {
  return error.response && 
         (error.response.status === 503 || error.response.status === 429) &&
         (error.message.includes('Rate Limiter') || 
          error.message.includes('rate limit') ||
          error.message.includes('too many requests'));
}

/**
 * Rate limiting and retry logic for MDBList API calls
 */
async function makeRateLimitedRequest<T>(
  requestFn: () => Promise<T>, 
  context: string = 'MDBList', 
  retries: number = RATE_LIMIT_CONFIG.maxRetries
): Promise<T> {
  const now = Date.now();
  
  // Check if we're currently rate limited
  if (rateLimitState.isRateLimited && rateLimitState.rateLimitResetTime > now) {
    const waitTime = rateLimitState.rateLimitResetTime - now + 1000; // Add 1 second buffer
    console.log(`[${context}] Rate limit active, waiting ${waitTime}ms until reset`);
    await sleep(waitTime);
    rateLimitState.isRateLimited = false;
    rateLimitState.rateLimitResetTime = 0;
  }
  
  // Check minimum interval between requests
  const timeSinceLastRequest = now - rateLimitState.lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT_CONFIG.minInterval) {
    const waitTime = RATE_LIMIT_CONFIG.minInterval - timeSinceLastRequest;
    await sleep(waitTime);
  }
  
  const startTime = Date.now();
  let attempt = 0;
  
  while (attempt < retries) {
    attempt++;
    const isLastAttempt = attempt === retries;
    
    try {
      const response = await requestFn();
      const responseTime = Date.now() - startTime;
      
      // Track successful request
      const requestTracker = require('../lib/requestTracker.js');
      requestTracker.trackProviderCall('mdblist', responseTime, true);
      
      // Reset rate limiting state on success
      rateLimitState.lastRequestTime = Date.now();
      rateLimitState.recentRateLimitHits = 0;
      rateLimitState.isRateLimited = false;
      
      return response;
      
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      
      // Track failed request
      const requestTracker = require('../lib/requestTracker.js');
      requestTracker.trackProviderCall('mdblist', responseTime, false);
      
      if (isRateLimitError(error)) {
        // Track recent rate limit hits
        if (now - rateLimitState.lastRateLimitTime < 30000) { // Within last 30 seconds
          rateLimitState.recentRateLimitHits++;
        } else {
          rateLimitState.recentRateLimitHits = 1;
        }
        rateLimitState.lastRateLimitTime = now;
        
        if (isLastAttempt) {
          console.error(`[${context}] Rate limit exceeded after ${retries} attempts:`, error.message);
          throw error;
        }
        
        // Calculate backoff delay
        let baseBackoffTime = RATE_LIMIT_CONFIG.rateLimitDelay;
        if (rateLimitState.recentRateLimitHits > 3) {
          baseBackoffTime *= 2; // Double the delay if we're hitting rate limits frequently
        }
        
        // Add jitter to prevent thundering herd
        const jitter = Math.random() * 1000;
        const totalDelay = Math.min(baseBackoffTime + jitter, RATE_LIMIT_CONFIG.maxDelay);
        
        console.warn(
          `[${context}] Rate limit hit (${rateLimitState.recentRateLimitHits} recent hits). ` +
          `Retrying in ${Math.round(totalDelay)}ms (attempt ${attempt}/${retries})`
        );
        
        // Log rate limit warning for dashboard
        requestTracker.logError('warning', `MDBList API rate limit hit`, {
          retries: attempt,
          maxRetries: retries,
          backoffTime: Math.round(totalDelay),
          recentHits: rateLimitState.recentRateLimitHits,
          context: context
        });
        
        // Set rate limit state
        rateLimitState.isRateLimited = true;
        rateLimitState.rateLimitResetTime = now + totalDelay;
        
        await sleep(totalDelay);
        continue;
      }
      
      // For non-rate-limit errors, use exponential backoff
      if (isLastAttempt) {
        console.error(`[${context}] Request failed after ${retries} attempts:`, error.message);
        throw error;
      }
      
      const delay = Math.min(
        RATE_LIMIT_CONFIG.baseDelay * Math.pow(RATE_LIMIT_CONFIG.backoffMultiplier, attempt - 1),
        RATE_LIMIT_CONFIG.maxDelay
      );
      
      console.log(`[${context}] Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  
  throw new Error(`All ${retries} attempts failed`);
}

async function fetchMDBListItems(listId: string, apiKey: string, language: string, page: number): Promise<any[]> {
  const offset = (page * 20) - 20;
  
  try {
    const url = `https://api.mdblist.com/lists/${listId}/items?language=${language}&limit=20&offset=${offset}&apikey=${apiKey}&append_to_response=genre,poster`;
    
    const response: any = await makeRateLimitedRequest(
      () => httpGet(url),
      `MDBList fetchMDBListItems (listId: ${listId}, page: ${page})`
    );
    
    console.log(`[MDBList] fetchMDBListItems completed (undici)`);
    
    return [
      ...(response.data.movies || []),
      ...(response.data.shows || [])
    ];
  } catch (err: any) {
    console.error("Error retrieving MDBList items:", err.message);
    return [];
  }
}

/**
 * Fetches batch media info from MDBList API for multiple IDs
 * Automatically handles batching for requests exceeding 200 items
 * @param {string} mediaProvider - The media provider (tmdb, imdb, trakt, tvdb, mal)
 * @param {string} mediaType - The media type (movie, show, any)
 * @param {Array<string>} ids - Array of IDs to fetch info for
 * @param {string} apiKey - MDBList API key
 * @param {Array<string>} appendToResponse - Optional array of additional data to append
 * @returns {Promise<Array>} Array of media info objects
 */
async function fetchMDBListBatchMediaInfo(mediaProvider: string, mediaType: string, ids: string[], apiKey: string, appendToResponse: string[] = []): Promise<any[]> {
  if (!ids || ids.length === 0 || !apiKey) {
    console.warn("[MDBList] Missing required parameters for batch media info");
    return [];
  }

  const BATCH_SIZE = 200;
  const allResults: any[] = [];

  // Split IDs into batches of 200
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batchIds = ids.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(ids.length / BATCH_SIZE);

    console.log(`[MDBList] Processing batch ${batchNumber}/${totalBatches} with ${batchIds.length} items`);

    try {
      const url = `https://api.mdblist.com/${mediaProvider}/${mediaType}?apikey=${apiKey}`;
      
      const requestBody = {
        ids: batchIds,
        append_to_response: appendToResponse
      };

      const response: any = await makeRateLimitedRequest(
        () => httpPost(url, requestBody, {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 30000 // 30 second timeout for batch requests
        }),
        `MDBList batch media info (batch ${batchNumber}/${totalBatches})`
      );

      if (response.data && Array.isArray(response.data)) {
        console.log(`[MDBList] Batch ${batchNumber}/${totalBatches} successful: ${response.data.length} items (undici)`);
        allResults.push(...response.data);
      } else {
        console.warn(`[MDBList] Batch ${batchNumber}/${totalBatches} unexpected response format:`, response.data);
      }

    } catch (error: any) {
      console.error(`[MDBList] Error in batch ${batchNumber}/${totalBatches}:`, error.message);
      if (error.response) {
        console.error(`[MDBList] Response status: ${error.response.status}`);
        console.error(`[MDBList] Response data:`, error.response.data);
      }
      // Continue with next batch even if this one fails
    }

    // Add a delay between batches to be respectful to the API
    if (i + BATCH_SIZE < ids.length) {
      await sleep(500); // Increased from 100ms to 500ms for better rate limiting
    }
  }

  console.log(`[MDBList] Completed all batches. Total items fetched: ${allResults.length}`);
  return allResults;
}

async function getGenresFromMDBList(listId: string, apiKey: string): Promise<string[]> {
  try {
    const items = await fetchMDBListItems(listId, apiKey, 'en-US', 1);
    const genres = [
      ...new Set(
        items.flatMap((item: any) =>
          (item.genre || []).map((g: any) => {
            if (!g || typeof g !== "string") return null;
            return g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
          })
        ).filter(Boolean)
      )
    ].sort();
    return genres;
  } catch(err: any) {
    console.error("ERROR in getGenresFromMDBList:", err);
    return [];
  }
}


async function parseMDBListItems(items: any[], type: string, genreFilter: string, language: string, config: UserConfig): Promise<any[]> {
  let filteredItems = items;
  if (genreFilter) {
    filteredItems = filteredItems.filter(item =>
      Array.isArray(item.genre) &&
      item.genre.some((g: any) => typeof g === "string" && g.toLowerCase() === genreFilter.toLowerCase())
    );
  }
  //console.log(`[MDBList] Filtered items: ${JSON.stringify(filteredItems)}`);

  const targetMediaType = type === 'series' ? 'show' : 'movie';
  //const batchMediaInfo = await fetchMDBListBatchMediaInfo('tmdb', targetMediaType, filteredItems.map(item => item.id), config.apiKeys?.mdblist || '');
  //console.log(`[MDBList] Batch media info: ${JSON.stringify(batchMediaInfo)}`);

  // Determine preferred provider
  let preferredProvider: string;
  if (type === 'movie') {
    preferredProvider = config.providers?.movie || 'tmdb';
  } else {
    preferredProvider = config.providers?.series || 'tvdb';
  }
 
  const metas = await Promise.all(filteredItems
    .filter(item => item.mediatype === targetMediaType)
    .map(async (item: any) => {
      try {
        // Resolve IDs to get the best stremioId
        const targetProviders = new Set();
        if (preferredProvider !== 'tmdb') targetProviders.add(preferredProvider);
        
        let allIds;
        let stremioId = `tmdb:${item.id}`;
        if (targetProviders.size > 0) {
          const targetProviderArray = Array.from(targetProviders);
          allIds = await resolveAllIds(`tmdb:${item.id}`, type, config, null, targetProviderArray);
          
          if(preferredProvider === 'tvdb' && allIds?.tvdbId) {
            stremioId = `tvdb:${allIds.tvdbId}`;
          } else if(preferredProvider === 'tvmaze' && allIds?.tvmazeId) {
            stremioId = `tvmaze:${allIds.tvmazeId}`;
          } else if(preferredProvider === 'imdb' && allIds?.imdbId) {
            stremioId = allIds.imdbId;
          }
        }
        
        // Use getMeta with cacheWrapMetaSmart to get the full meta object with caching
        const result = await cacheWrapMetaSmart(config.userUUID, stremioId, async () => {
          return await getMeta(type, language, stremioId, config, config.userUUID);
        }, undefined, {enableErrorCaching: true, maxRetries: 2}, type as any);
        
        if (result && result.meta) {
          return result.meta;
        }
        return null;
      } catch (error: any) {
        console.error(`[MDBList] Error getting meta for item ${item.id}:`, error.message);
        return null;
      }
    }));

  return metas.filter(Boolean);
}

export { fetchMDBListItems, fetchMDBListBatchMediaInfo, getGenresFromMDBList, parseMDBListItems };
