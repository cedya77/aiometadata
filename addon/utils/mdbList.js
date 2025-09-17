const { httpGet, httpPost } = require("./httpClient");
const { it } = require("node:test");
const { resolveAllIds } = require("../lib/id-resolver");
const Utils = require("./parseProps");
const moviedb = require("../lib/getTmdb");

const host = process.env.HOST_NAME.startsWith('http')
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
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is a rate limit error
 */
function isRateLimitError(error) {
  return error.response && 
         (error.response.status === 503 || error.response.status === 429) &&
         (error.message.includes('Rate Limiter') || 
          error.message.includes('rate limit') ||
          error.message.includes('too many requests'));
}

/**
 * Rate limiting and retry logic for MDBList API calls
 */
async function makeRateLimitedRequest(requestFn, context = 'MDBList', retries = RATE_LIMIT_CONFIG.maxRetries) {
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
      const requestTracker = require('../lib/requestTracker');
      requestTracker.trackProviderCall('mdblist', responseTime, true);
      
      // Reset rate limiting state on success
      rateLimitState.lastRequestTime = Date.now();
      rateLimitState.recentRateLimitHits = 0;
      rateLimitState.isRateLimited = false;
      
      return response;
      
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      // Track failed request
      const requestTracker = require('../lib/requestTracker');
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
}

async function fetchMDBListItems(listId, apiKey, language, page) {
  const offset = (page * 20) - 20;
  
  try {
    const url = `https://api.mdblist.com/lists/${listId}/items?language=${language}&limit=20&offset=${offset}&apikey=${apiKey}&append_to_response=genre,poster`;
    
    const response = await makeRateLimitedRequest(
      () => httpGet(url),
      `MDBList fetchMDBListItems (listId: ${listId}, page: ${page})`
    );
    
    const responseTime = Date.now() - Date.now(); // This will be tracked in makeRateLimitedRequest
    console.log(`[MDBList] fetchMDBListItems completed in ${responseTime}ms (undici)`);
    
    return [
      ...(response.data.movies || []),
      ...(response.data.shows || [])
    ];
  } catch (err) {
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
async function fetchMDBListBatchMediaInfo(mediaProvider, mediaType, ids, apiKey, appendToResponse = []) {
  if (!ids || ids.length === 0 || !apiKey) {
    console.warn("[MDBList] Missing required parameters for batch media info");
    return [];
  }

  const BATCH_SIZE = 200;
  const allResults = [];

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

      const response = await makeRateLimitedRequest(
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

    } catch (error) {
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

async function getGenresFromMDBList(listId, apiKey) {
  try {
    const items = await fetchMDBListItems(listId, apiKey, 'en-US', 1);
    const genres = [
      ...new Set(
        items.flatMap(item =>
          (item.genre || []).map(g => {
            if (!g || typeof g !== "string") return null;
            return g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
          })
        ).filter(Boolean)
      )
    ].sort();
    return genres;
  } catch(err) {
    console.error("ERROR in getGenresFromMDBList:", err);
    return [];
  }
}


async function parseMDBListItems(items, type, genreFilter, language, config) {
  let filteredItems = items;
  console.log(`[MDBList] current genreFilter: ${genreFilter}`);
  if (genreFilter && genreFilter.toLowerCase() !== 'none') {
    filteredItems = filteredItems.filter(item =>
      Array.isArray(item.genre) &&
      item.genre.some(g => typeof g === "string" && g.toLowerCase() === genreFilter.toLowerCase())
    );
  }
  //console.log(`[MDBList] Filtered items: ${JSON.stringify(filteredItems)}`);

  const targetMediaType = type === 'series' ? 'show' : 'movie';
  const batchMediaInfo = await fetchMDBListBatchMediaInfo('tmdb', targetMediaType, filteredItems.map(item => item.id), config.apiKeys?.mdblist);
  //console.log(`[MDBList] Batch media info: ${JSON.stringify(batchMediaInfo)}`);
 
  const metas = await Promise.all(filteredItems
    .filter(item => item.mediatype === targetMediaType)
    .map(async item => {
      try {
        let allIds;
        let preferredProvider;
        if (type === 'movie') {
          preferredProvider = config.providers?.movie || 'tmdb';
        } else {
          preferredProvider = config.providers?.series || 'tvdb';
        }
        
        // Check all three art types and collect non-meta providers
        const posterProvider = Utils.resolveArtProvider(type, 'poster', config);
        const backgroundProvider = Utils.resolveArtProvider(type, 'background', config);
        const logoProvider = Utils.resolveArtProvider(type, 'logo', config);

        // Collect all unique non-meta providers
        const targetProviders = new Set();
        if (posterProvider !== preferredProvider && posterProvider !== 'tmdb' && posterProvider !== 'fanart') targetProviders.add(posterProvider);
        if (backgroundProvider !== preferredProvider && backgroundProvider !== 'tmdb' && backgroundProvider !== 'fanart') targetProviders.add(backgroundProvider);
        if (logoProvider !== preferredProvider && logoProvider !== 'tmdb' && logoProvider !== 'fanart') targetProviders.add(logoProvider);
        if (preferredProvider !== 'tmdb') targetProviders.add(preferredProvider);
        if ((posterProvider === 'fanart' || backgroundProvider === 'fanart' || logoProvider === 'fanart') && type === 'series') targetProviders.add('tvdb');

        let stremioId = `tmdb:${item.id}`;
        if (targetProviders.size > 0) {
          const targetProviderArray = Array.from(targetProviders);
          allIds = await resolveAllIds(`tmdb:${item.id}`, type, config, null, targetProviderArray);
        } else {
          allIds = { tmdbId: item.id, tvdbId: null, imdbId: null, malId: null, kitsuId: null, tvmazeId: null, anidbId: null, anilistId: null };
        }

        if(preferredProvider === 'tvdb' && allIds?.tvdbId) {
          stremioId = `tvdb:${allIds.tvdbId}`;
        } else if(preferredProvider === 'tvmaze' && allIds?.tvmazeId) {
          stremioId = `tvmaze:${allIds.tvmazeId}`;
        } else if(preferredProvider === 'imdb' && allIds?.imdbId) {
          stremioId = allIds.imdbId;
        }

        const batchMediaItem = batchMediaInfo.find(media => media.ids?.tmdb === item.id);
        const posterPath = batchMediaItem?.poster || item.poster;
        const tmdbPosterFullUrl = posterPath 
          ? `https://image.tmdb.org/t/p/w500${posterPath}` 
          : `https://artworks.thetvdb.com/banners/images/missing/${type}.jpg`;
        let posterUrl = tmdbPosterFullUrl;
        if(allIds) {
          if (type === 'movie') {
            posterUrl = await Utils.getMoviePoster({
              tmdbId: item.id,
              tvdbId: allIds.tvdbId,
              imdbId: allIds.imdbId,
              metaProvider: preferredProvider,
              fallbackPosterUrl: tmdbPosterFullUrl
            }, config);
          } else {
            posterUrl = await Utils.getSeriesPoster({
              tmdbId: allIds.tmdbId,
              tvdbId: allIds.tvdbId,
              imdbId: allIds.imdbId,
              metaProvider: preferredProvider,
                fallbackPosterUrl: tmdbPosterFullUrl
              }, config);
          }
        }
        //console.log(`[MDBList] Batch media info: ${JSON.stringify(batchMediaInfo.find(media => media.id === item.id))}`);
        const posterProxyUrl = `${host}/poster/${type}/${stremioId}?fallback=${encodeURIComponent(posterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
        //console.log (`[MDBList] ${JSON.stringify(item)}`);
        return {
          id: stremioId,
          type: type,
          imdb_id: allIds?.imdbId,
          name: item.title || item.name,
          poster: posterProxyUrl,
          logo: type === 'movie' ? await moviedb.getTmdbMovieLogo(item.id, config) : await moviedb.getTmdbSeriesLogo(item.id, config),
          description: Utils.addMetaProviderAttribution(batchMediaItem?.description || '', 'MDBList', config),
          runtime: Utils.parseRunTime(batchMediaItem?.runtime || null),
          imdbRating: String(batchMediaItem?.ratings?.find(rating => rating.source === 'imdb')?.value || 'N/A'),
          genres: item.genre || [],
          year: item.release_year || null,
          releaseInfo: item.release_year || null,
        };
      } catch (error) {
        console.error(`[MDBList] Error resolving IDs for item ${item.id}:`, error.message);
        const fallbackPosterUrl = item.poster ? `https://image.tmdb.org/t/p/w500${item.poster}` : `https://artworks.thetvdb.com/banners/images/missing/${type}.jpg`;
        const posterProxyUrl = `${host}/poster/${type}/tmdb:${item.id}?fallback=${encodeURIComponent(fallbackPosterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
        return {
          id: `tmdb:${item.id}`,
          type: type,
          name: item.title || item.name,
          poster: posterProxyUrl,
          year: item.release_year || null,
          releaseInfo: item.release_year || null,
        };
      }
    }));

  return metas.filter(Boolean);
}

module.exports = { fetchMDBListItems, fetchMDBListBatchMediaInfo, getGenresFromMDBList, parseMDBListItems };
