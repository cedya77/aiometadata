require("dotenv").config();
const { httpGet } = require('../utils/httpClient');
const https = require('https');

const robustAgent = new https.Agent({
  family: 4, // Force IPv4
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 10,
  timeout: 60000,
  freeSocketTimeout: 30000
});

const JIKAN_API_BASE = process.env.JIKAN_API_BASE || 'https://api.jikan.moe/v4';

const BASE_REQUEST_DELAY = 200;
const MAX_RETRIES = 3;
const RATE_LIMIT_DELAY = 1000;    

let requestQueue = [];
let isProcessing = false;
let activeRequests = 0;
const MAX_CONCURRENT_REQUESTS = 1;
let recentRateLimitHits = 0;
let lastRateLimitTime = 0;
console.log(`[Jikan] Keep-Alive is enabled with optimized rate limiting.`);


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
    setTimeout(processQueue, 50);
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

  try {
    const result = await requestTask.task();
    
    requestTask.resolve(result);
    
  } catch (error) {
    if (error.response && error.response.status === 429 && requestTask.retries < MAX_RETRIES) {
      requestTask.retries++; 
      
      // Track recent rate limit hits
      const now = Date.now();
      if (now - lastRateLimitTime < 30000) { // Within last 30 seconds
        recentRateLimitHits++;
      } else {
        recentRateLimitHits = 1; // Reset counter
      }
      lastRateLimitTime = now;

      // Increase backoff time if we're hitting rate limits frequently
      let baseBackoffTime = Math.pow(2, requestTask.retries - 1) * RATE_LIMIT_DELAY;
      if (recentRateLimitHits > 3) {
        baseBackoffTime *= 2; // Double the delay if we're hitting rate limits frequently
      }
      
      const jitter = Math.random() * 200;
      const totalDelay = baseBackoffTime + jitter;

      console.warn(
        `Jikan rate limit hit (${recentRateLimitHits} recent hits). Retrying in ${Math.round(totalDelay)}ms. ` +
        `(Attempt ${requestTask.retries}/${MAX_RETRIES})`
      );
      
      // Log rate limit warning for dashboard
      const requestTracker = require('./requestTracker');
      requestTracker.logError('warning', `MAL API rate limit hit`, {
        retries: requestTask.retries,
        maxRetries: MAX_RETRIES,
        backoffTime: Math.round(totalDelay),
        recentHits: recentRateLimitHits,
        url: requestTask.url
      });

      // Re-queue with delay
      setTimeout(() => {
        requestQueue.unshift(requestTask);
        if (!isProcessing) {
          processQueue();
        }
      }, totalDelay);
      
    } else {
      if (requestTask.retries >= MAX_RETRIES) {
        console.error(`Jikan request failed for "${requestTask.url}" after ${MAX_RETRIES} retries. Giving up.`);
      }
      if (error.code) {
        console.error(`[NETWORK DEBUG] Jikan request for "${requestTask.url}" failed with network error code: ${error.code}`);
      }
      if (error.cause) {
        console.error(`[NETWORK DEBUG] Underlying cause:`, error.cause);
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
  console.log(`Jikan request for: ${url}`);
  const startTime = Date.now();
  
  try {
    const response = await httpGet(url, { timeout: 15000, httpsAgent: robustAgent });
    const responseTime = Date.now() - startTime;
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('mal', responseTime, true);
    
    console.log(`[MAL] Request completed in ${responseTime}ms (undici)`);
    return response;
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    // Track failed request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('mal', responseTime, false);
    
    // Log error for dashboard
    requestTracker.logError('error', `MAL API request failed: ${error.message}`, {
      url: url,
      responseTime: responseTime,
      status: error.response?.status
    });
    
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
  console.log(`Jikan request for: ${url}`);
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      console.error(`A critical error occurred while searching for anime with query "${query}"`, e.message);
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
  console.log(`Fetching all episode data for MAL ID: ${malId}`);
  const results = await jikanGetAllPages(`/anime/${malId}/episodes`);
  console.log(`Finished fetching. Total episodes collected for MAL ID ${malId}: ${results.length}`);
  return results;
}

async function getAnimeEpisodeVideos(malId) {
  console.log(`Fetching all episode thumbnail data for MAL ID: ${malId}`);
  const results = await jikanGetAllPages(`/anime/${malId}/videos/episodes`);
  console.log(`Finished fetching. Total episode videos collected for MAL ID ${malId}: ${results.length}`);
  return results;
}

async function getAnimeCharacters(malId) {
  const url = `${JIKAN_API_BASE}/anime/${malId}/characters`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      console.error(`Could not fetch characters for MAL ID ${malId}:`, e.message);
      return [];
    });
}


async function getAnimeByVoiceActor(personId) {
  const url = `${JIKAN_API_BASE}/people/${personId}/full`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data?.voices || [])
    .catch(e => {
      console.error(`Could not fetch roles for person ID ${personId}:`, e.message);
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
        console.error(`Could not fetch page ${page} for endpoint ${endpoint}:`, e.message);
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
    const pagePromises = [];
    for (let page = 2; page <= actualTotalPagesToFetch; page++) {
      pagePromises.push(_fetchPage(page).then(result => result?.data || []));
    }
    const resultsByPage = await Promise.all(pagePromises);
    allItems = allItems.concat(resultsByPage.flat());
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
      console.error(`Failed to fetch page ${page} for endpoint ${endpoint}:`, error.message);
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
      console.error(`Could not fetch airing schedule for ${day}, page ${page}:`, e.message);
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
      console.error(`Could not fetch currently airing anime, page ${page}:`, e.message);
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
      console.error(`Could not fetch upcoming anime , page ${page}:`, e.message);
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
    console.error(`Jikan API Error: Could not fetch anime for genre ID ${genreId}, page ${page}. URL: ${url}`, error.message);
    return []; 
  }
}


async function getAnimeGenres() {
  const url = `${JIKAN_API_BASE}/genres/anime`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      console.error(`Could not fetch anime genres from Jikan`, e.message);
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
      console.error(`Could not fetch top anime between ${startDate} and ${endDate}, page ${page}:`, e.message);
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
      console.error(`Could not fetch top  anime, page ${page}:`, e.message);
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
      console.error(`Could not fetch top anime by filter ${filter}, page ${page}:`, e.message);
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
      console.error(`Could not fetch anime for studio ID ${studioId}:`, e.message);
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
};
