require("dotenv").config();
const { httpGet } = require('../utils/httpClient');
const { socksDispatcher } = require('fetch-socks');
const { Agent, ProxyAgent } = require('undici');
const consola = require('consola');
const redis = require('./redisClient');
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

// --- Rate limit configuration ---
// Jikan limits: 3 requests/second, 60 requests/minute
// We stay conservative for shared instances where the cache warmer + multiple
// users can generate bursts. Self-hosted Jikan can override via env vars.
const MAX_CONCURRENT = parseInt(process.env.JIKAN_MAX_CONCURRENT, 10) || 2;  // In-flight requests at once
const MIN_REQUEST_INTERVAL = parseInt(process.env.JIKAN_MIN_INTERVAL, 10) || 350; // ms between dispatches
const MAX_REQUESTS_PER_MINUTE = parseInt(process.env.JIKAN_MAX_PER_MINUTE, 10) || 55; // Stay under 60/min
const MAX_RETRIES = 3;
const RATE_LIMIT_DELAY = 2000;

// --- Queue state ---
let requestQueue = [];
let activeRequests = 0;
let isProcessing = false;
let rateLimitHitTimestamps = [];
let requestTimestamps = [];       // Sliding window for per-minute tracking
let lastDispatchTime = 0;
let adaptiveConcurrency = MAX_CONCURRENT;  // Dynamically reduced on 429s
let lastAdaptiveRestore = Date.now();


// --- Adaptive concurrency ---
// When we hit rate limits, temporarily reduce concurrency.
// Gradually restore it after a cool-down period.
function onRateLimitHit() {
  const now = Date.now();
  rateLimitHitTimestamps.push(now);
  rateLimitHitTimestamps = rateLimitHitTimestamps.filter(t => now - t < 60000);

  // Drop to 1 concurrent on any 429
  adaptiveConcurrency = 1;
  lastAdaptiveRestore = now;

  logger.warn(`[Rate Limiter] Concurrency reduced to 1 (${rateLimitHitTimestamps.length} hits in last 60s)`);
}

function maybeRestoreConcurrency() {
  const now = Date.now();
  const recentHits = rateLimitHitTimestamps.filter(t => now - t < 60000).length;

  // Only restore if no 429s for 30 seconds
  if (recentHits === 0 && now - lastAdaptiveRestore > 30000 && adaptiveConcurrency < MAX_CONCURRENT) {
    adaptiveConcurrency = Math.min(adaptiveConcurrency + 1, MAX_CONCURRENT);
    lastAdaptiveRestore = now;
    logger.debug(`[Rate Limiter] Concurrency restored to ${adaptiveConcurrency}/${MAX_CONCURRENT}`);
  }
}

// --- Per-minute sliding window check ---
function getMinuteWaitTime() {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < 60000);

  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    const oldestInWindow = requestTimestamps[0];
    const waitMs = 60000 - (now - oldestInWindow) + 150; // 150ms safety buffer
    return Math.max(0, waitMs);
  }
  return 0;
}


// --- Core queue processor ---
// Dispatches up to `adaptiveConcurrency` requests concurrently,
// respecting both per-second and per-minute rate limits.
async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    // Check if we can dispatch another concurrent request
    if (activeRequests >= adaptiveConcurrency) {
      // Wait for a slot to free up
      await new Promise(resolve => setTimeout(resolve, 50));
      continue;
    }

    // Per-minute rate limit check
    const minuteWait = getMinuteWaitTime();
    if (minuteWait > 0) {
      logger.debug(`[Rate Limiter] Per-minute limit approaching (${requestTimestamps.length}/${MAX_REQUESTS_PER_MINUTE}), waiting ${minuteWait}ms`);
      await new Promise(resolve => setTimeout(resolve, minuteWait));
      continue;
    }

    // Per-second spacing: enforce minimum interval between dispatches
    const now = Date.now();
    const timeSinceLast = now - lastDispatchTime;
    const perSecondWait = Math.max(0, MIN_REQUEST_INTERVAL - timeSinceLast);
    if (perSecondWait > 0) {
      await new Promise(resolve => setTimeout(resolve, perSecondWait));
    }

    // Grab the next task
    const task = requestQueue.shift();
    if (!task) break;

    // Record dispatch time
    lastDispatchTime = Date.now();
    requestTimestamps.push(lastDispatchTime);
    activeRequests++;

    // Fire and don't await — let it run concurrently
    processRequest(task).finally(() => {
      activeRequests--;
      maybeRestoreConcurrency();

      // Kick the queue again in case it stalled waiting for a slot
      if (requestQueue.length > 0 && !isProcessing) {
        processQueue();
      }
    });
  }

  isProcessing = false;

  if (requestQueue.length > 0) {
    processQueue();
  }
}

async function processRequest(requestTask) {
  const startTime = Date.now();
  try {
    const result = await requestTask.task();
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('mal', responseTime, true);
    requestTask.resolve(result);
  } catch (error) {
    const isRateLimit = error.response?.status === 429;
    const isTimeout = error.code && (
        error.code.includes('TIMEOUT') ||
        error.code.includes('UND_ERR_HEADERS_TIMEOUT') ||
        error.code.includes('UND_ERR_BODY_TIMEOUT')
    );
    const isRetryable = (isRateLimit || isTimeout) && requestTask.retries < MAX_RETRIES;

    if (isRetryable) {
      requestTask.retries++;

      if (isRateLimit) {
        onRateLimitHit();

        const recentHitCount = rateLimitHitTimestamps.length;
        let baseBackoffTime = Math.pow(2, requestTask.retries - 1) * RATE_LIMIT_DELAY;
        if (recentHitCount > 10) baseBackoffTime *= 2.5;
        else if (recentHitCount > 5) baseBackoffTime *= 1.8;
        const jitter = Math.random() * 300;
        const totalDelay = baseBackoffTime + jitter;

        logger.warn(
          `Jikan rate limit hit (${recentHitCount} hits in last 60s). Retrying in ${Math.round(totalDelay)}ms. ` +
          `(Attempt ${requestTask.retries}/${MAX_RETRIES})`
        );

        const requestTracker = require('./requestTracker');
        requestTracker.logError('warning', `MAL API rate limit hit`, {
          retries: requestTask.retries,
          backoffTime: Math.round(totalDelay),
          url: requestTask.url
        });

        setTimeout(() => {
          // Re-queue at front with high priority
          requestQueue.unshift(requestTask);
          if (!isProcessing) processQueue();
        }, totalDelay);

      } else if (isTimeout) {
        const timeoutDelay = Math.pow(2, requestTask.retries - 1) * 1000;
        const totalDelay = timeoutDelay + (Math.random() * 500);
        logger.warn(
          `Jikan request timeout for "${requestTask.url}". Retrying in ${Math.round(totalDelay)}ms.`
        );
        setTimeout(() => {
          requestQueue.unshift(requestTask);
          if (!isProcessing) processQueue();
        }, totalDelay);
      }
    } else {
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('mal', responseTime, false);
      if (requestTask.retries >= MAX_RETRIES) {
        logger.error(`Jikan request failed for "${requestTask.url}" after ${MAX_RETRIES} retries.`);
        requestTracker.logError('error', `MAL API request failed`, {
           status: error.response?.status,
           message: error.message
        });
      }
      requestTask.reject(error);
    }
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
  const etagKey = `mal_etag:${url}`;
  
  let etag = null;
  if (redis) {
      etag = await redis.get(etagKey);
  }

  const headers = {};
  if (etag) {
    headers['If-None-Match'] = etag;
  }

  const response = await httpGet(url, {
      dispatcher: malDispatcher,
      headers: headers,
      timeout: 15000,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304
  });
    
  if (response.status === 304) {
       if (redis) {
           const cachedBody = await redis.get(`mal_cache:${url}`);
           if (cachedBody) {
               logger.debug(`[304] Using Redis cached body for ${url}`);
               return { data: JSON.parse(cachedBody) };
           }
       }
       logger.warn(`[304] ETag match but body missing for ${url}. Re-fetching without ETag...`);
       return httpGet(url, { dispatcher: malDispatcher, timeout: 15000, headers: {} });
  }

  if (response.headers?.etag && redis) {
      const TTL = 25 * 60 * 60; 
      await redis.set(etagKey, response.headers.etag, 'EX', TTL);
      await redis.set(`mal_cache:${url}`, JSON.stringify(response.data), 'EX', TTL);
  }
  
  return response;
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

  function _fetchPage(page) {
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

  // First page: need pagination info
  const firstPageResponse = await _fetchPage(1);
  if (!firstPageResponse.data || firstPageResponse.data.length === 0) {
    return [];
  }
  allItems.push(...firstPageResponse.data);

  const lastVisiblePage = firstPageResponse.pagination?.last_visible_page || 1;
  const actualTotalPagesToFetch = Math.min(desiredPages, lastVisiblePage);

  if (actualTotalPagesToFetch > 1) {
    // Enqueue all remaining pages at once — queue handles pacing
    const pagePromises = [];
    for (let page = 2; page <= actualTotalPagesToFetch; page++) {
      pagePromises.push(
        _fetchPage(page).then(result => result?.data || [])
      );
    }
    const results = await Promise.all(pagePromises);
    for (const pageData of results) {
      if (pageData.length > 0) {
        allItems.push(...pageData);
      }
    }
  }

  return allItems.slice(0, totalItemsToFetch);
}

// --- Get all pages: fetches until no more pages exist ---
// First page is awaited to get pagination info, then remaining pages
// are enqueued all at once for concurrent processing.
async function jikanGetAllPages(endpoint, initialParams = {}) {
  let allItems = [];

  // Fetch first page to discover total pages
  const firstParams = new URLSearchParams({ ...initialParams, page: 1 });
  const firstUrl = `${JIKAN_API_BASE}${endpoint}?${firstParams.toString()}`;

  try {
    const firstResponse = await enqueueRequest(() => _makeJikanRequest(firstUrl), firstUrl);
    const firstData = firstResponse.data;

    if (!firstData?.data || firstData.data.length === 0) return [];
    allItems.push(...firstData.data);

    const hasNextPage = firstData.pagination?.has_next_page || false;
    const lastPage = firstData.pagination?.last_visible_page || 1;

    if (!hasNextPage || lastPage <= 1) return allItems;

    // Enqueue all remaining pages at once
    const pagePromises = [];
    for (let page = 2; page <= lastPage; page++) {
      const params = new URLSearchParams({ ...initialParams, page: page });
      const url = `${JIKAN_API_BASE}${endpoint}?${params.toString()}`;
      pagePromises.push(
        enqueueRequest(() => _makeJikanRequest(url), url)
          .then(response => response.data?.data || [])
          .catch(error => {
            logger.warn(`Failed to fetch page ${page} for endpoint ${endpoint}:`, error.message || error);
            return [];
          })
      );
    }

    const results = await Promise.all(pagePromises);
    for (const pageData of results) {
      allItems.push(...pageData);
    }
  } catch (error) {
    logger.warn(`Failed to fetch first page for endpoint ${endpoint}:`, error.message || error);
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

async function fetchDiscover(params = {}, page = 1) {
  const JIKAN_PAGE_LIMIT = 25;
  const queryParams = {
    page: page,
    limit: JIKAN_PAGE_LIMIT,
  };

  // order_by: score, popularity, rank, members, favorites, start_date, end_date, episodes, title
  if (params.order_by) {
    queryParams.order_by = params.order_by;
  }

  // sort: asc, desc
  if (params.sort) {
    queryParams.sort = params.sort;
  }

  // type: tv, movie, ova, special, ona
  if (params.type) {
      queryParams.type = params.type;
  }

  // status: airing, complete, upcoming
  if (params.status) {
    queryParams.status = params.status;
  }

  // rating: g, pg, pg13, r17, r, rx
  if (params.rating) {
    queryParams.rating = params.rating;
  }

  // genres: comma-separated MAL genre IDs (include)
  if (params.genres) {
    queryParams.genres = String(params.genres);
  }

  // genres_exclude: comma-separated MAL genre IDs (exclude)
  if (params.genres_exclude) {
    queryParams.genres_exclude = String(params.genres_exclude);
  }

  // producers: comma-separated MAL producer/studio IDs
  if (params.producers) {
    queryParams.producers = String(params.producers);
  }

  // min_score: 0-10
  if (params.min_score && Number(params.min_score) > 0) {
    queryParams.min_score = Number(params.min_score);
  }

  // max_score: 0-10
  if (params.max_score && Number(params.max_score) < 10) {
    queryParams.max_score = Number(params.max_score);
  }

  // start_date: YYYY-MM-DD (aired after)
  if (params.start_date) {
    queryParams.start_date = params.start_date;
  }

  // end_date: YYYY-MM-DD (aired before)
  if (params.end_date) {
    queryParams.end_date = params.end_date;
  }

  // sfw filter
  if (params.sfw === true || params.sfw === 'true') {
    queryParams.sfw = true;
  }

  const urlParams = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/anime?${urlParams.toString()}`;

  try {
    const response = await enqueueRequest(() => _makeJikanRequest(url), url);
    let animeList = response.data?.data || [];
    const pagination = response.data?.pagination || {};

    return {
      items: animeList,
      hasMore: pagination.has_next_page || false,
      total: pagination.items?.total || animeList.length,
      currentPage: pagination.current_page || page,
    };
  } catch (error) {
    logger.error(`[MAL Discover] Error fetching discover: ${error.message}`);
    throw error;
  }
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
  fetchDiscover
};
