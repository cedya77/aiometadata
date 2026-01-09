require("dotenv").config();
const { httpGet } = require('../utils/httpClient');
const { socksDispatcher } = require('fetch-socks');
const { Agent, ProxyAgent } = require('undici');
const consola = require('consola');
const logger = consola.withTag('MAL');

const JIKAN_API_BASE = process.env.JIKAN_API_BASE || 'https://api.jikan.moe/v4';

// ETag cache for Jikan API responses (in-memory cache)
const etagCache = new Map(); // { url: { etag: string, data: any, timestamp: number } }

// Clean up ETag cache every hour (remove entries older than 24 hours)
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours (matches Jikan's cache duration)
  let cleaned = 0;

  for (const [url, entry] of etagCache.entries()) {
    if (now - entry.timestamp > maxAge) {
      etagCache.delete(url);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug(`Cleaned ${cleaned} expired ETag entries. Cache size: ${etagCache.size}`);
  }
}, 60 * 60 * 1000); // Run every hour

// MAL/Jikan dispatcher configuration
// Priority: MAL_SOCKS_PROXY_URL > HTTPS_PROXY/HTTP_PROXY > direct connection
const MAL_SOCKS_PROXY_URL = process.env.MAL_SOCKS_PROXY_URL;
const HTTP_PROXY_URL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
let malDispatcher;

if (MAL_SOCKS_PROXY_URL) {
  try {
    const proxyUrlObj = new URL(MAL_SOCKS_PROXY_URL);
    if (proxyUrlObj.protocol === 'socks5:' || proxyUrlObj.protocol === 'socks4:') {
      malDispatcher = socksDispatcher({
        type: proxyUrlObj.protocol === 'socks5:' ? 5 : 4,
        host: proxyUrlObj.hostname,
        port: parseInt(proxyUrlObj.port),
        userId: proxyUrlObj.username,
        password: proxyUrlObj.password,
      });
      logger.info(`SOCKS proxy is enabled for Jikan API via fetch-socks.`);
    } else {
      logger.warn(`Unsupported proxy protocol: ${proxyUrlObj.protocol}. Falling back.`);
      malDispatcher = null; // Will be set below
    }
  } catch (error) {
    logger.warn(`Invalid MAL_SOCKS_PROXY_URL. Falling back. Error: ${error.message}`);
    malDispatcher = null; // Will be set below
  }
}

// Fallback to HTTP proxy or direct connection
if (!malDispatcher) {
  if (HTTP_PROXY_URL) {
    try {
      malDispatcher = new ProxyAgent({ uri: new URL(HTTP_PROXY_URL).toString() });
      logger.info('Using global HTTP proxy for Jikan API.');
    } catch (error) {
      logger.warn(`Invalid HTTP_PROXY URL. Using direct connection. Error: ${error.message}`);
      malDispatcher = new Agent({ connect: { timeout: 30000 } });
    }
  } else {
    malDispatcher = new Agent({ connect: { timeout: 30000 } });
    logger.info('undici agent is enabled for direct connections.');
  }
}

const BASE_REQUEST_DELAY = 400;  // 400ms = ~2.5 req/sec (safer margin under 3 req/sec limit)
const MAX_RETRIES = 3;
const RATE_LIMIT_DELAY = 1500;    // 1.5s for faster recovery    

let requestQueue = [];
let isProcessing = false;
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 1;
let rateLimitHitTimestamps = []; // Track timestamps of rate limit hits
logger.info(`Keep-Alive is enabled with optimized rate limiting.`);


async function processQueue() {
  if (requestQueue.length === 0) {
    isProcessing = false;
    return; 
  }

  isProcessing = true;
  
  // Process multiple requests concurrently if queue is small and we have capacity
  const requestsToProcess = Math.min(
    requestQueue.length,
    MAX_CONCURRENT_REQUESTS - activeRequests
  );
  
  if (requestsToProcess <= 0) {
    // Wait a bit and try again
    setTimeout(processQueue, 25);
    return;
  }
  
  const tasks = [];
  for (let i = 0; i < requestsToProcess; i++) {
    const requestTask = requestQueue.shift();
    tasks.push(processRequest(requestTask));
  }
  
  // Wait for all requests to complete
  await Promise.allSettled(tasks);
  
  // Always add a small delay between batches to be respectful to the API
  setTimeout(processQueue, BASE_REQUEST_DELAY);
}

async function processRequest(requestTask) {
  activeRequests++;
  let nextDelay = 0; 
  const startTime = Date.now();

  try {
    const result = await requestTask.task();
    
    // Track final success (after all retries if any)
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('mal', responseTime, true);
    
    requestTask.resolve(result);
    
  } catch (error) {
    // Check if this is a retryable error (rate limit or timeout)
    const isRateLimit = error.response && error.response.status === 429;
    const isTimeout = error.code && (error.code.includes('TIMEOUT') || error.code.includes('UND_ERR_HEADERS_TIMEOUT') || error.code.includes('UND_ERR_BODY_TIMEOUT'));
    const isRetryable = (isRateLimit || isTimeout) && requestTask.retries < MAX_RETRIES;
    
    if (isRetryable) {
      requestTask.retries++; 
      
      if (isRateLimit) {
        // Track rate limit hits using a sliding window (last 60 seconds)
        const now = Date.now();
        rateLimitHitTimestamps.push(now);
        
        // Remove hits older than 60 seconds
        rateLimitHitTimestamps = rateLimitHitTimestamps.filter(timestamp => now - timestamp < 60000);
        
        const recentHitCount = rateLimitHitTimestamps.length;

        // Increase backoff time if we're hitting rate limits frequently
        let baseBackoffTime = Math.pow(2, requestTask.retries - 1) * RATE_LIMIT_DELAY;
        if (recentHitCount > 10) {
          baseBackoffTime *= 2.5; // 2.5x delay if hitting rate limits very frequently
        } else if (recentHitCount > 5) {
          baseBackoffTime *= 1.8; // 1.8x delay if hitting frequently
        } else if (recentHitCount > 2) {
          baseBackoffTime *= 1.3; // 1.3x delay if hitting moderately
        }
        
        const jitter = Math.random() * 300;
        const totalDelay = baseBackoffTime + jitter;

        logger.warn(
          `Jikan rate limit hit (${recentHitCount} hits in last 60s). Retrying in ${Math.round(totalDelay)}ms. ` +
          `(Attempt ${requestTask.retries}/${MAX_RETRIES})`
        );
        
        // Log rate limit warning for dashboard (but don't count as failure yet)
        const requestTracker = require('./requestTracker');
        requestTracker.logError('warning', `MAL API rate limit hit`, {
          retries: requestTask.retries,
          maxRetries: MAX_RETRIES,
          backoffTime: Math.round(totalDelay),
          recentHits: recentHitCount,
          url: requestTask.url
        });

        // Re-queue with delay
        setTimeout(() => {
          requestQueue.unshift(requestTask);
          if (!isProcessing) {
            processQueue();
          }
        }, totalDelay);
      } else if (isTimeout) {
        // Retry timeout errors with exponential backoff
        const timeoutDelay = Math.pow(2, requestTask.retries - 1) * 1000; // 1s, 2s, 4s
        const jitter = Math.random() * 500;
        const totalDelay = timeoutDelay + jitter;
        
        logger.warn(
          `Jikan request timeout for "${requestTask.url}". Retrying in ${Math.round(totalDelay)}ms. ` +
          `(Attempt ${requestTask.retries}/${MAX_RETRIES})`
        );
        
        // Log timeout warning for dashboard (but don't count as failure yet)
        const requestTracker = require('./requestTracker');
        requestTracker.logError('warning', `MAL API timeout`, {
          retries: requestTask.retries,
          maxRetries: MAX_RETRIES,
          backoffTime: Math.round(totalDelay),
          url: requestTask.url,
          errorCode: error.code
        });

        // Re-queue with delay
        setTimeout(() => {
          requestQueue.unshift(requestTask);
          if (!isProcessing) {
            processQueue();
          }
        }, totalDelay);
      }
      
    } else {
      // Track final failure (after all retries exhausted or non-retryable error)
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('mal', responseTime, false);
      
      if (requestTask.retries >= MAX_RETRIES) {
        logger.error(`Jikan request failed for "${requestTask.url}" after ${MAX_RETRIES} retries. Giving up.`);
        requestTracker.logError('error', `MAL API request failed after ${MAX_RETRIES} retries`, {
          url: requestTask.url,
          responseTime: responseTime,
          status: error.response?.status
        });
      }
      if (error.code) {
        logger.debug(`Jikan request for "${requestTask.url}" failed with network error code: ${error.code}`);
      }
      if (error.cause) {
        logger.debug(`Underlying cause:`, error.cause);
      }

      requestTask.reject(error);
    }
  } finally {
    activeRequests--;
  }
}

function enqueueRequest(task, url) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ resolve, reject, task, url, retries: 0 });
    if (!isProcessing) {
      processQueue();
    }
  });
}

async function _makeJikanRequest(url) {
  const startTime = Date.now();
  
  try {
    // Check if we have a cached ETag for this URL
    const cached = etagCache.get(url);
    const headers = {};
    
    if (cached && cached.etag) {
      headers['If-None-Match'] = cached.etag;
      //logger.debug(`Jikan request for: ${url} (with ETag validation)`);
    } else {
      //logger.debug(`Jikan request for: ${url}`);
    }
    
    const response = await httpGet(url, { 
      dispatcher: malDispatcher,
      headers: headers,
      timeout: 15000 // 15 second timeout for Jikan API (some endpoints can be slow)
    });
    const responseTime = Date.now() - startTime;
    
    // Store ETag if present
    if (response.headers?.etag) {
      etagCache.set(url, {
        etag: response.headers.etag,
        data: response,
        timestamp: Date.now()
      });
    }
    
    // Note: Success/failure tracking is done in processRequest() to track final outcome only
    //logger.debug(`Request completed in ${responseTime}ms (undici)`);
    return response;
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    // Handle 304 Not Modified - return cached data
    if (error.response?.status === 304) {
      const cached = etagCache.get(url);
      if (cached && cached.data) {
        //logger.debug(`Cache hit (304) for: ${url} in ${responseTime}ms`);
        return cached.data;
      }
    }
    
    // Note: Success/failure tracking is done in processRequest() to track final outcome only
    // Re-throw to let processRequest handle retries
    
    throw error;
  }
}

async function searchAnime(type, query, limit = 25, config = {}, page = 1) {
  let url = `${JIKAN_API_BASE}/anime?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}`;
  if (config.sfw) {
    url += `&sfw=true`;
  }

  let queryType;
  switch (type) {
    case "movie": queryType = 'movie'; break;
    case "tv": queryType = 'tv'; break;
    case "anime": queryType= null; break;
  }
  if (queryType) {
    url += `&type=${queryType}`;
  }
  //logger.debug(`Jikan request for: ${url}`);
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.error(`A critical error occurred while searching for anime with query "${query}"`, e.message);
      return [];
    });
}

/**
 * Fetches detailed information for a specific anime by its MAL ID.
 */
async function getAnimeDetails(malId) {
  const url = `${JIKAN_API_BASE}/anime/${malId}/full`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || null)
    .catch(() => null); 
}


async function getAnimeEpisodes(malId) {
  //logger.debug(`Fetching all episode data for MAL ID: ${malId}`);
  const results = await jikanGetAllPages(`/anime/${malId}/episodes`);
  //logger.debug(`Finished fetching. Total episodes collected for MAL ID ${malId}: ${results.length}`);
  return results;
}

async function getAnimeEpisodeVideos(malId) {
  //logger.debug(`Fetching all episode thumbnail data for MAL ID: ${malId}`);
  const results = await jikanGetAllPages(`/anime/${malId}/videos/episodes`);
  //logger.debug(`Finished fetching. Total episode videos collected for MAL ID ${malId}: ${results.length}`);
  return results;
}

async function getAnimeCharacters(malId) {
  const url = `${JIKAN_API_BASE}/anime/${malId}/characters`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.warn(`Could not fetch characters for MAL ID ${malId}:`, e.message);
      return [];
    });
}


async function getAnimeByVoiceActor(personId) {
  const url = `${JIKAN_API_BASE}/people/${personId}/full`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data?.voices || [])
    .catch(e => {
      logger.warn(`Could not fetch roles for person ID ${personId}:`, e.message);
      return [];
    });
}

/**
 * A generic paginator for any Jikan API endpoint that supports pagination.
 * It fetches multiple pages and combines the results.
 *
 * @param {string} endpoint - The Jikan endpoint path (e.g., '/seasons/now', '/genres/anime').
 * @param {number} totalItemsToFetch - The total number of items you want to get.
 * @param {object} [queryParams={}] - Any additional query parameters for the URL (like 'q', 'genres', 'rating').
 * @returns {Promise<Array>} - A promise that resolves to a flat array of all fetched items.
 */
async function jikanPaginator(endpoint, totalItemsToFetch, queryParams = {}) {
  const JIKAN_PAGE_LIMIT = 25;
  const desiredPages = Math.ceil(totalItemsToFetch / JIKAN_PAGE_LIMIT);
  let allItems = [];

  async function _fetchPage(page) {
    const params = new URLSearchParams({
      page: page,
      limit: JIKAN_PAGE_LIMIT,
      ...queryParams
    });
    const url = `${JIKAN_API_BASE}${endpoint}?${params.toString()}`;
    return enqueueRequest(() => _makeJikanRequest(url), url)
      .then(response => response.data || { data: [], pagination: {} })
      .catch(e => {
        logger.warn(`Could not fetch page ${page} for endpoint ${endpoint}:`, e.message);
        return { data: [], pagination: {} };
      });
  }

  const firstPageResponse = await _fetchPage(1);
  if (!firstPageResponse.data || firstPageResponse.data.length === 0) {
    return [];
  }

  allItems.push(...firstPageResponse.data);
  const lastVisiblePage = firstPageResponse.pagination?.last_visible_page || 1;
  const actualTotalPagesToFetch = Math.min(desiredPages, lastVisiblePage);

  if (actualTotalPagesToFetch > 1) {
    // Fetch pages sequentially instead of in parallel to respect rate limits
    for (let page = 2; page <= actualTotalPagesToFetch; page++) {
      const result = await _fetchPage(page);
      const pageData = result?.data || [];
      if (pageData.length > 0) {
        allItems.push(...pageData);
      }
    }
  }

  return allItems.slice(0, totalItemsToFetch);
}


/**
 * A generic paginator for fetching all entries from a given Jikan endpoint.
 * This is used for endpoints that don't need complex query parameters.
 * @param {string} endpoint - The full Jikan endpoint path (e.g., `/anime/21/episodes`).
 * @returns {Promise<Array>} - A promise that resolves to a flat array of all fetched items.
 */
async function jikanGetAllPages(endpoint, initialParams = {}) {
  let allItems = [];
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage) {
    const params = new URLSearchParams({
      ...initialParams,
      page: page,
    });
    const url = `${JIKAN_API_BASE}${endpoint}?${params.toString()}`;
    try {
      const response = await enqueueRequest(() => _makeJikanRequest(url), url);
      const data = response.data;
      
      if (data?.data && data.data.length > 0) {
        allItems.push(...data.data);
        hasNextPage = data.pagination?.has_next_page || false;
      } else {
        hasNextPage = false;
      }
    } catch (error) {
      logger.warn(`Failed to fetch page ${page} for endpoint ${endpoint}:`, error.message || error || 'Unknown error');
      hasNextPage = false; 
    }
    page++;
  }
  return allItems;
}


/**
 * Fetches the airing schedule for a specific day of the week.
 * @param {string} day - The day of the week in lowercase (e.g., 'monday', 'tuesday').
 * @param {object} [config={}] - The user's configuration for age rating.
 * @returns {Promise<Array>} - An array of anime objects scheduled for that day.
 */
async function getAiringSchedule(day, page = 1, config = {}) {
  const queryParams = {
    filter: day.toLowerCase(),
    page: page
  };

  if (config.sfw) {
    queryParams.sfw = true;
  }

  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/schedules?${params.toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.warn(`Could not fetch airing schedule for ${day}, page ${page}:`, e.message);
      return [];
    });
}

async function getAiringNow(page = 1, config = {}) {
  const queryParams = {
    page: page
  };
  if (config.sfw) {
    queryParams.sfw = true;
  }
  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/seasons/now?${params.toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.warn(`Could not fetch currently airing anime, page ${page}:`, e.message);
      return [];
    });
}

async function getUpcoming(page = 1, config = {}) {
  const queryParams = {
    page: page
  };
  if (config.sfw) {
    queryParams.sfw = true;
  }
  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/seasons/upcoming?${params.toString()}`;
  
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.warn(`Could not fetch upcoming anime , page ${page}:`, e.message);
      return [];
    });
}

async function getAnimeByGenre(genreId, typeFilter = null, page = 1 , config = {}) {
  const queryParams = {
    genres: genreId,
    order_by: 'members',
    sort: 'desc',
    page: page,
  };

  if (typeFilter) {
    let jikanType = typeFilter.toLowerCase();
    if (jikanType === 'series') {
      jikanType = 'tv';
    }
    if (genreId !==12){
      queryParams.type = jikanType;
    }
    
  }

  if (config.sfw) {
    queryParams.sfw = true;
  }
  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/anime?${params.toString()}`;
  try {
    const response = await enqueueRequest(() => _makeJikanRequest(url), url);
    const animeList = response.data?.data || [];

    const desiredTypes = new Set(['tv', 'movie', 'ova', 'ona']);
    return animeList.filter(anime => anime.type && desiredTypes.has(anime.type.toLowerCase()));

  } catch (error) {
    logger.error(`Jikan API Error: Could not fetch anime for genre ID ${genreId}, page ${page}. URL: ${url}`, error.message);
    return []; 
  }
}


async function getAnimeGenres() {
  const url = `${JIKAN_API_BASE}/genres/anime`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.error(`Could not fetch anime genres from Jikan`, e.message);
      return [];
    });
}


/**
 * A generic paginator for fetching top anime within a specific date range.
 *
 * @param {string} startDate - The start date in YYYY-MM-DD format.
 * @param {string} endDate - The end date in YYYY-MM-DD format.
 * @param {number} totalItemsToFetch - The total number of items you want to get.
 * @param {object} [config={}] - The user's configuration for age rating.
 * @returns {Promise<Array>} - A promise that resolves to a flat array of all fetched anime.
 */
async function getTopAnimeByDateRange(startDate, endDate, page = 1, genreId, config = {}) {
  const queryParams = {
    start_date: startDate,
    end_date: endDate,
    order_by: 'members', 
    sort: 'desc',
    page: page,
  };

  if (genreId) {
    queryParams.genres = genreId;
  }

  if (config.sfw) {
    queryParams.sfw = true;
  }

  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/anime?${params.toString()}`;   
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.warn(`Could not fetch top anime between ${startDate} and ${endDate}, page ${page}:`, e.message);
      return [];
  });
}

/**
 * Fetches top anime from Jikan based on different criteria.
 * @param {string} type - The type of top anime to fetch ('anime', 'movie', 'tv', 'bypopularity', 'byfavorites', 'byrating')
 * @param {number} [page=1] - Page number
 * @param {object} [config={}] - Configuration object for age rating
 * @returns {Promise<Array>} - Array of anime objects
 */
async function getTopAnimeByType(type, page = 1, config = {}) {
  const types = ['movie', 'tv', 'ova', 'ona'];
  const queryParams = {
    page: page,
  };
  if (types.includes(type)) {
    queryParams.type = type;
  }

  if (config.sfw) {
    queryParams.sfw = true;
  }

  const url = `${JIKAN_API_BASE}/top/anime?${new URLSearchParams(queryParams).toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.warn(`Could not fetch top  anime, page ${page}:`, e.message);
      return [];
    });
}

async function getTopAnimeByFilter(filter, page = 1, config = {}) { 
  const queryParams = {
    page: page,
    filter: filter
  };
  
  if (config.sfw) {
    queryParams.sfw = true;
  }

  const url = `${JIKAN_API_BASE}/top/anime?${new URLSearchParams(queryParams).toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.warn(`Could not fetch top anime by filter ${filter}, page ${page}:`, e.message);
      return [];
    });
}

/**
 * Fetches the list of anime studios (producers) from Jikan.
 * @param {number} [limit=100] - Number of studios to fetch (max 25 per page, will fetch multiple pages if needed)
 * @returns {Promise<Array>} - Array of studio objects
 */
async function getStudios(limit = 100) {
  const queryParams = {
    order_by: 'favorites',
    sort: 'desc'
  }; 
  const endpoint = `/producers`;
  return jikanPaginator(endpoint, limit, queryParams);
}

/**
 * Fetches anime for a given studio (producer) ID from Jikan.
 * @param {number|string} studioId - The MAL studio/producer ID
 * @param {number} [page=1] - Page number
 * @param {number} [limit=25] - Number of anime per page
 * @returns {Promise<Array>} - Array of anime objects
 */
async function getAnimeByStudio(studioId, page = 1, limit = 25) {
  const url = `${JIKAN_API_BASE}/anime?producers=${studioId}&order_by=members&sort=desc&page=${page}&limit=${limit}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.warn(`Could not fetch anime for studio ID ${studioId}:`, e.message);
      return [];
    });
}

/**
 * Fetches anime for a specific season (e.g., winter 2024).
 * @param {number} year - The year (e.g., 2024)
 * @param {string} season - The season ('winter', 'spring', 'summer', 'fall')
 * @param {number} [page=1] - Page number
 * @param {object} [config={}] - Configuration object for age rating
 * @returns {Promise<Array>} - Array of anime objects
 */
async function getAnimeBySeason(year, season, page = 1, config = {}) {
  const queryParams = {
    page: page
  };
  if (config.sfw) {
    queryParams.sfw = true;
  }
  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/seasons/${year}/${season}?${params.toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.warn(`Could not fetch anime for ${season} ${year}, page ${page}:`, e.message);
      return [];
    });
}

/**
 * Fetches available seasons from Jikan API.
 * Returns data in format: [{ year: 2024, seasons: ['winter', 'spring', 'summer', 'fall'] }, ...]
 * @returns {Promise<Array>} - Array of season objects with year and available seasons
 */
async function getAvailableSeasons() {
  const url = `${JIKAN_API_BASE}/seasons`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      logger.error(`Could not fetch available seasons:`, e.message);
      return [];
    });
}


module.exports = {
  searchAnime,
  getAnimeDetails,
  getAnimeEpisodes,
  getAnimeEpisodeVideos,
  getAnimeCharacters,
  getAnimeByVoiceActor,
  getAnimeByGenre,
  getAnimeGenres,
  getAiringNow,
  getUpcoming,
  getTopAnimeByType,
  getTopAnimeByFilter,
  getTopAnimeByDateRange,
  getAiringSchedule,
  getStudios,
  getAnimeByStudio,
  getAnimeBySeason,
  getAvailableSeasons,
};
