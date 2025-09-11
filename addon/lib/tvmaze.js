const { httpGet } = require('../utils/httpClient');
const { cacheWrapTvmazeApi } = require('./getCache');
const packageJson = require('../../package.json');
const TVMAZE_API_URL = 'https://api.tvmaze.com';
const DEFAULT_TIMEOUT = 15000; // 15-second timeout for all requests
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second base delay
const RATE_LIMIT_DELAY = 5000; // 5 seconds for rate limit backoff (TVmaze recommends "a few seconds")
const MAX_RATE_LIMIT_RETRIES = 5; // More retries for rate limiting

// Global rate limiting to prevent hitting TVmaze too frequently
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 100; // Minimum 100ms between requests

// Default HTTP client config with User-Agent as recommended by TVmaze
const DEFAULT_HTTP_CONFIG = {
  timeout: DEFAULT_TIMEOUT,
  headers: {
    'User-Agent': `${packageJson.name}/${packageJson.version} (https://github.com/cedya77/aiometadata)`
  }
};

/**
 * Sleep function for retry delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limiting function to prevent hitting TVmaze too frequently
 */
async function rateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
    const delay = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
    await sleep(delay);
  }
  
  lastRequestTime = Date.now();
}

/**
 * A helper to check for 404s and returns a specific value, otherwise logs the error.
 */
function handleHttpError(error, context) {
  if (error.response && error.response.status === 404) {
    console.log(`${context}: Resource not found (404).`);
    return { notFound: true };
  }
  
  // Log network errors more concisely
  if (error.code === 'ECONNABORTED' || error.code === 'ENETUNREACH' || error.code === 'ECONNREFUSED') {
    console.error(`${context}: Network error (${error.code}) - ${error.message}`);
  } else {
    console.error(`Error in ${context}:`, error.message || 'No error message available');
  }
  
  return { error: true };
}

/**
 * Retry wrapper for API calls
 */
async function retryApiCall(apiCall, context, retries = MAX_RETRIES) {
  let rateLimitRetries = 0;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Apply rate limiting before each request
      await rateLimit();
      return await apiCall();
    } catch (error) {
      const isLastAttempt = attempt === retries;
      const isRateLimit = error.response && error.response.status === 429;
      const isRetryableError = error.code === 'ECONNABORTED' || 
                              error.code === 'ENETUNREACH' || 
                              error.code === 'ECONNREFUSED' ||
                              (error.response && (error.response.status === 429 || error.response.status >= 500));
      
      // Handle rate limiting more aggressively
      if (isRateLimit) {
        rateLimitRetries++;
        if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
          console.error(`${context}: Max rate limit retries (${MAX_RATE_LIMIT_RETRIES}) exceeded. Giving up.`);
          return null;
        }
        
        // Progressive backoff for rate limits: 5s, 10s, 15s, 20s, 25s
        const rateLimitDelay = RATE_LIMIT_DELAY * rateLimitRetries;
        console.log(`${context}: Rate limited (attempt ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES}), waiting ${rateLimitDelay}ms before retry...`);
        await sleep(rateLimitDelay);
        continue; // Don't count this as a regular retry attempt
      }
      
      if (isLastAttempt || !isRetryableError) {
        const { notFound } = handleHttpError(error, context);
        return notFound ? null : null;
      }
      
      // Exponential backoff for other errors: 1s, 2s, 4s
      const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
      console.log(`${context}: Attempt ${attempt} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
}


/**
 * Gets the basic show object from TVmaze using an IMDb ID.
 * Note: TVmaze lookup API returns 301 redirects, which we handle by following the redirect
 * and then making a separate request to get the show data.
 */
async function getShowByImdbId(imdbId) {
  const cacheKey = `lookup-shows-imdb:${imdbId}`;
  
  return cacheWrapTvmazeApi(cacheKey, async () => {
    const url = `${TVMAZE_API_URL}/lookup/shows?imdb=${imdbId}`;
    const context = `getShowByImdbId for IMDb ${imdbId}`;
    
    return await retryApiCall(async () => {
      try {
        const response = await httpGet(url, DEFAULT_HTTP_CONFIG);
        return response.data;
      } catch (error) {
        // Handle 301 redirects from TVmaze lookup API
        if (error.response && error.response.status === 301) {
          const location = error.response.headers?.location;
          if (location) {
            // Extract show ID from the redirected URL (e.g., /shows/123 -> 123)
            const showIdMatch = location.match(/\/shows\/(\d+)/);
            if (showIdMatch) {
              const showId = parseInt(showIdMatch[1]);
              // Make a direct request to get the show data
              const showUrl = `${TVMAZE_API_URL}/shows/${showId}`;
              const showResponse = await httpGet(showUrl, DEFAULT_HTTP_CONFIG);
              return showResponse.data;
            }
          }
        }
        throw error;
      }
    }, context);
  });
}

/**
 * Gets the full show details, including all episodes and cast, using a TVmaze ID.
 */
async function getShowDetails(tvmazeId) {
  const cacheKey = `shows-details:${tvmazeId}`;
  
  return cacheWrapTvmazeApi(cacheKey, async () => {
    const url = `${TVMAZE_API_URL}/shows/${tvmazeId}?embed[]=cast&embed[]=crew`;
    const context = `getShowDetails for TVmaze ID ${tvmazeId}`;
    
    return await retryApiCall(async () => {
      const response = await httpGet(url, DEFAULT_HTTP_CONFIG);
      return response.data;
    }, context);
  });
}

/**
 * Gets the episodes for a show.
 */
async function getShowEpisodes(tvmazeId) {
  const cacheKey = `shows-episodes:${tvmazeId}`;
  return cacheWrapTvmazeApi(cacheKey, async () => {
    const url = `${TVMAZE_API_URL}/shows/${tvmazeId}/episodes?specials=1`;
    const context = `getShowEpisodes for TVmaze ID ${tvmazeId}`;
    return await retryApiCall(async () => {
      const response = await httpGet(url, DEFAULT_HTTP_CONFIG);
      return response.data;
    }, context);
  });
}

/**
 * Gets the full show namely to retrieve external ids, using a TVmaze ID.
 */
async function getShowById(tvmazeId) {
  const cacheKey = `shows-basic:${tvmazeId}`;
  
  return cacheWrapTvmazeApi(cacheKey, async () => {
    const url = `${TVMAZE_API_URL}/shows/${tvmazeId}`;
    const context = `getShowById for TVmaze ID ${tvmazeId}`;
    
    return await retryApiCall(async () => {
      const response = await httpGet(url, DEFAULT_HTTP_CONFIG);
      return response.data;
    }, context);
  });
}


/**
 * Searches for shows on TVmaze based on a query.
 */
async function searchShows(query) {
  const cacheKey = `search-shows:${encodeURIComponent(query)}`;
  
  return cacheWrapTvmazeApi(cacheKey, async () => {
    const url = `${TVMAZE_API_URL}/search/shows?q=${encodeURIComponent(query)}`;
    const context = `searchShows for query "${query}"`;
    
    return await retryApiCall(async () => {
      const response = await httpGet(url, DEFAULT_HTTP_CONFIG);
      return response.data;
    }, context) || [];
  });
}

/**
 * Gets the basic show object from TVmaze using a TVDB ID.
 * Note: TVmaze lookup API returns 301 redirects, which we handle by following the redirect
 * and then making a separate request to get the show data.
 */
async function getShowByTvdbId(tvdbId) {
  const cacheKey = `lookup-shows-tvdb:${tvdbId}`;
  
  return cacheWrapTvmazeApi(cacheKey, async () => {
    const url = `${TVMAZE_API_URL}/lookup/shows?thetvdb=${tvdbId}`;
    const context = `getShowByTvdbId for TVDB ${tvdbId}`;
    
    return await retryApiCall(async () => {
      try {
        const response = await httpGet(url, DEFAULT_HTTP_CONFIG);
        return response.data;
      } catch (error) {
        // Handle 301 redirects from TVmaze lookup API
        if (error.response && error.response.status === 301) {
          const location = error.response.headers?.location;
          if (location) {
            // Extract show ID from the redirected URL (e.g., /shows/123 -> 123)
            const showIdMatch = location.match(/\/shows\/(\d+)/);
            if (showIdMatch) {
              const showId = parseInt(showIdMatch[1]);
              // Make a direct request to get the show data
              const showUrl = `${TVMAZE_API_URL}/shows/${showId}`;
              const showResponse = await httpGet(showUrl, DEFAULT_HTTP_CONFIG);
              return showResponse.data;
            }
          }
        }
        throw error;
      }
    }, context);
  });
}

/**
 * Searches for people on TVmaze.
 */
async function searchPeople(query) {
  const cacheKey = `search-people:${encodeURIComponent(query)}`;
  
  return cacheWrapTvmazeApi(cacheKey, async () => {
    const url = `${TVMAZE_API_URL}/search/people?q=${encodeURIComponent(query)}`;
    const context = `searchPeople for person "${query}"`;
    
    return await retryApiCall(async () => {
      const response = await httpGet(url, DEFAULT_HTTP_CONFIG);
      return response.data;
    }, context) || [];
  });
}

/**
 * Gets all cast credits for a person.
 */
async function getPersonCastCredits(personId) {
  const cacheKey = `people-castcredits:${personId}`;
  
  return cacheWrapTvmazeApi(cacheKey, async () => {
    const url = `${TVMAZE_API_URL}/people/${personId}/castcredits?embed=show`;
    const context = `getPersonCastCredits for person ID ${personId}`;
    
    return await retryApiCall(async () => {
      const response = await httpGet(url, DEFAULT_HTTP_CONFIG);
      return response.data;
    }, context) || [];
  });
}

module.exports = {
  getShowByImdbId,
  getShowDetails,
  getShowByTvdbId,
  searchShows,
  searchPeople,
  getPersonCastCredits,
  getShowById,
  getShowEpisodes
};