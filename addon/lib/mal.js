require("dotenv").config();
const axios = require('axios');
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

const BASE_REQUEST_DELAY = 350; 
const MAX_RETRIES = 3;      

let requestQueue = [];
let isProcessing = false;
console.log(`[Jikan] Keep-Alive is enabled.`);


async function processQueue() {
  if (requestQueue.length === 0) {
    isProcessing = false;
    return; 
  }

  isProcessing = true;
  const requestTask = requestQueue.shift();
  let nextDelay = BASE_REQUEST_DELAY; 

  try {
    const result = await requestTask.task();
    
    requestTask.resolve(result);
  } catch (error) {
    if (error.response && error.response.status === 429 && requestTask.retries < MAX_RETRIES) {
      requestTask.retries++; 

      const backoffTime = Math.pow(2, requestTask.retries - 1) * 1000;
      const jitter = Math.random() * 500; 
      nextDelay = backoffTime + jitter;

      console.warn(
        `Jikan rate limit hit. Retrying in ${Math.round(nextDelay)}ms. ` +
        `(Attempt ${requestTask.retries}/${MAX_RETRIES})`
      );

      requestQueue.unshift(requestTask);
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
  }

  setTimeout(processQueue, nextDelay);
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
  return axios.get(url, { timeout: 15000, httpsAgent: robustAgent });
}

async function searchAnime(type, query, limit = 20, config = {}, page = 1) {
  let url = `${JIKAN_API_BASE}/anime?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}`;
  if (config.ageRating) {
    let jikanRating;
    switch (config.ageRating) {
      case "G": jikanRating = 'g'; break;
      case "PG": jikanRating = 'pg'; break;
      case "PG-13": jikanRating = 'pg13'; break;
      case "R": jikanRating = 'r17'; break;
    }

    if (jikanRating) {
      url += `&rating=${jikanRating}`;
    }
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

  if (config.ageRating) {
    let jikanRating;
    switch (config.ageRating) {
      case "G": jikanRating = 'g'; break;
      case "PG": jikanRating = 'pg'; break;
      case "PG-13": jikanRating = 'pg13'; break;
      case "R": jikanRating = 'r17'; break;
    }
    if (jikanRating) {
      queryParams.rating = jikanRating;
    }
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
  if (config.ageRating) {
    let jikanRating;
    switch (config.ageRating) {
      case "G": jikanRating = 'g'; break;
      case "PG": jikanRating = 'pg'; break;
      case "PG-13": jikanRating = 'pg13'; break;
      case "R": jikanRating = 'r17'; break;
    }
    if (jikanRating) {
      queryParams.rating = jikanRating;
    }
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
  if (config.ageRating) {
    let jikanRating;
    switch (config.ageRating) {
      case "G": jikanRating = 'g'; break;
      case "PG": jikanRating = 'pg'; break;
      case "PG-13": jikanRating = 'pg13'; break;
      case "R": jikanRating = 'r17'; break;
    }
    if (jikanRating) {
      queryParams.rating = jikanRating;
    }
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

  if (config.ageRating) {
    let jikanRating;
    switch (config.ageRating) {
      case "G": jikanRating = 'g'; break;
      case "PG": jikanRating = 'pg'; break;
      case "PG-13": jikanRating = 'pg13'; break;
      case "R": jikanRating = 'r17'; break;
    }
    if (jikanRating) {
      queryParams.rating = jikanRating;
    }
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
async function getTopAnimeByDateRange(startDate, endDate, page = 1, config = {}) {
  const queryParams = {
    start_date: startDate,
    end_date: endDate,
    order_by: 'members', 
    sort: 'desc',
    page: page
  };

  if (config.ageRating) {
    let jikanRating;
    switch (config.ageRating) {
      case "G": jikanRating = 'g'; break;
      case "PG": jikanRating = 'pg'; break;
      case "PG-13": jikanRating = 'pg13'; break;
      case "R": jikanRating = 'r17'; break;
    }
    if (jikanRating) {
      queryParams.rating = jikanRating;
    }
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
  getTopAnimeByDateRange,
  getAiringSchedule,
  getStudios,
  getAnimeByStudio,
};
