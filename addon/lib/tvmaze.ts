import { httpGet } from '../utils/httpClient.js';
import { cacheWrapTvmazeApi } from './getCache.js';
const packageJson = require('../../package.json');
import { Agent, ProxyAgent } from 'undici';
const TVMAZE_API_URL = 'https://api.tvmaze.com';
const DEFAULT_TIMEOUT = 15000; // 15-second timeout for all requests
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second base delay
const RATE_LIMIT_DELAY = 2000; // 2 seconds for rate limit backoff (TVmaze recommends "a few seconds")

// TVmaze dispatcher configuration
// Priority: HTTPS_PROXY/HTTP_PROXY > direct connection
// (TVmaze doesn't have a service-specific proxy option)
const HTTP_PROXY_URL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
let tvmazeAgent: Agent | ProxyAgent;

if (HTTP_PROXY_URL) {
  try {
    tvmazeAgent = new ProxyAgent({ uri: new URL(HTTP_PROXY_URL).toString() });
    console.log('[TVmaze] Using global HTTP proxy.');
  } catch (error: any) {
    console.error(`[TVmaze] Invalid HTTP_PROXY URL. Using direct connection. Error: ${error.message}`);
    tvmazeAgent = new Agent({
      connections: 10,
      keepAliveTimeout: 30 * 1000,
    });
  }
} else {
  tvmazeAgent = new Agent({
    connections: 10, // Limit to a maximum of 10 concurrent connections to api.tvmaze.com
    keepAliveTimeout: 30 * 1000, // Keep sockets open for 30 seconds of inactivity
  });
  console.log('[TVmaze] undici agent is enabled for direct connections.');
}

// Default HTTP client config with User-Agent as recommended by TVmaze
const DEFAULT_HTTP_CONFIG = {
  timeout: DEFAULT_TIMEOUT,
  headers: {
    'User-Agent': `${packageJson.name}/${packageJson.version} (https://github.com/cedya77/aiometadata)`
  },
  dispatcher: tvmazeAgent,
};

// Type definitions for TVmaze API responses
interface TVmazeShow {
  id: number;
  url: string;
  name: string;
  type: string;
  language: string;
  genres: string[];
  status: string;
  runtime: number;
  averageRuntime: number;
  premiered: string;
  ended: string;
  officialSite: string;
  schedule: {
    time: string;
    days: string[];
  };
  rating: {
    average: number;
  };
  weight: number;
  network: {
    id: number;
    name: string;
    country: {
      name: string;
      code: string;
      timezone: string;
    };
  } | null;
  webChannel: {
    id: number;
    name: string;
    country: {
      name: string;
      code: string;
      timezone: string;
    };
  } | null;
  dvdCountry: string | null;
  externals: {
    tvrage: number | null;
    thetvdb: number | null;
    imdb: string | null;
    themoviedb: number | null;
  };
  image: {
    medium: string;
    original: string;
  } | null;
  summary: string;
  updated: number;
  _links: {
    self: {
      href: string;
    };
    previousepisode: {
      href: string;
    };
  };
}

interface TVmazeCast {
  person: {
    id: number;
    url: string;
    name: string;
    country: {
      name: string;
      code: string;
      timezone: string;
    } | null;
    birthday: string | null;
    deathday: string | null;
    gender: string;
    image: {
      medium: string;
      original: string;
    } | null;
    updated: number;
    _links: {
      self: {
        href: string;
      };
    };
  };
  character: {
    id: number;
    url: string;
    name: string;
    image: {
      medium: string;
      original: string;
    } | null;
    _links: {
      self: {
        href: string;
      };
    };
  };
  self: boolean;
  voice: boolean;
}

interface TVmazeCrew {
  type: string;
  person: {
    id: number;
    url: string;
    name: string;
    country: {
      name: string;
      code: string;
      timezone: string;
    } | null;
    birthday: string | null;
    deathday: string | null;
    gender: string;
    image: {
      medium: string;
      original: string;
    } | null;
    updated: number;
    _links: {
      self: {
        href: string;
      };
    };
  };
}

interface TVmazeShowDetails extends TVmazeShow {
  _embedded: {
    cast: TVmazeCast[];
    crew: TVmazeCrew[];
  };
}

interface TVmazeEpisode {
  id: number;
  url: string;
  name: string;
  season: number;
  number: number;
  type: string;
  airdate: string;
  airtime: string;
  airstamp: string;
  runtime: number;
  rating: {
    average: number;
  };
  image: {
    medium: string;
    original: string;
  } | null;
  summary: string;
  _links: {
    self: {
      href: string;
    };
    show: {
      href: string;
    };
  };
}

interface TVmazeSearchResult {
  score: number;
  show: TVmazeShow;
}

interface TVmazePerson {
  id: number;
  url: string;
  name: string;
  country: {
    name: string;
    code: string;
    timezone: string;
  } | null;
  birthday: string | null;
  deathday: string | null;
  gender: string;
  image: {
    medium: string;
    original: string;
  } | null;
  updated: number;
  _links: {
    self: {
      href: string;
    };
  };
}

interface TVmazePersonSearchResult {
  score: number;
  person: TVmazePerson;
}

interface TVmazeCastCredit {
  _links: {
    self: {
      href: string;
    };
  };
  _embedded: {
    show: TVmazeShow;
  };
}

interface ApiError {
  notFound?: boolean;
  error?: boolean;
}

interface TVmazeScheduleEntry extends TVmazeEpisode {
  _embedded?: {
    show?: TVmazeShow;
  };
}

/**
 * Sleep function for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * A helper to check for 404s and returns a specific value, otherwise logs the error.
 */
function handleHttpError(error: any, context: string): ApiError {
  if (error.response && error.response.status === 404) {
    console.log(`${context}: Resource not found (404).`);
    return { notFound: true };
  }
  
  // Handle redirect errors (301, 302, etc.)
  if (error.response && error.response.status >= 300 && error.response.status < 400) {
    console.error(`${context}: HTTP ${error.response.status} redirect error - ${error.message || 'Redirect failed'}`);
    return { error: true };
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
async function retryApiCall<T>(
  apiCall: () => Promise<T>, 
  context: string, 
  retries: number = MAX_RETRIES
): Promise<T | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      const isLastAttempt = attempt === retries;
      const isRetryableError = (error as any).code === 'ECONNABORTED' || 
                              (error as any).code === 'ENETUNREACH' || 
                              (error as any).code === 'ECONNREFUSED' ||
                              ((error as any).response && ((error as any).response.status === 429 || (error as any).response.status >= 500));
      
      // Don't retry redirect errors (3xx) - they should be handled by the HTTP client
      const isRedirectError = (error as any).response && (error as any).response.status >= 300 && (error as any).response.status < 400;
      
      if (isLastAttempt || !isRetryableError || isRedirectError) {
        const { notFound } = handleHttpError(error, context);
        return notFound ? null : null;
      }
      
      // Exponential backoff: 1s, 2s, 4s (or fixed delay for rate limits as per TVmaze docs)
      const isRateLimit = (error as any).response && (error as any).response.status === 429;
      const delay = isRateLimit ? RATE_LIMIT_DELAY : RETRY_DELAY * Math.pow(2, attempt - 1);
      console.log(`${context}: Attempt ${attempt} failed${isRateLimit ? ' (rate limited)' : ''}, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  return null;
}

/**
 * Gets the basic show object from TVmaze using an IMDb ID.
 * Note: TVmaze lookup API returns 301 redirects, which we handle by following the redirect
 * and then making a separate request to get the show data.
 */
async function getShowByImdbId(imdbId: string): Promise<TVmazeShow | null> {
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
async function getShowDetails(tvmazeId: number): Promise<TVmazeShowDetails | null> {
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
async function getShowEpisodes(tvmazeId: number): Promise<TVmazeEpisode[] | null> {
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
async function getShowById(tvmazeId: number): Promise<TVmazeShow | null> {
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
async function searchShows(query: string): Promise<TVmazeSearchResult[]> {
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
async function getShowByTvdbId(tvdbId: number): Promise<TVmazeShow | null> {
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
async function searchPeople(query: string): Promise<TVmazePersonSearchResult[]> {
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
async function getPersonCastCredits(personId: number): Promise<TVmazeCastCredit[]> {
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

/**
 * Fetches the web channel schedule for a specific date and country.
 */
async function getFullSchedule(date: string, country: string): Promise<TVmazeScheduleEntry[]> {
  // Check if country is null, undefined, or empty string
  const hasCountry = country != null && country.trim().length > 0;
  const normalizedCountry = hasCountry ? country.trim() : 'default';
  const cacheKey = `schedule-full:${normalizedCountry}:${date}`;
  console.log(`getFullSchedule: ${cacheKey}`);

  return cacheWrapTvmazeApi(cacheKey, async () => {
    // Only include country parameter if it's provided and non-empty
    const url = hasCountry 
      ? `${TVMAZE_API_URL}/schedule?date=${date}&country=${normalizedCountry}`
      : `${TVMAZE_API_URL}/schedule?date=${date}`;
    const context = hasCountry 
      ? `getFullSchedule for ${normalizedCountry} on ${date}`
      : `getFullSchedule on ${date}`;
    console.log(`getFullSchedule: ${url}`);

    return await retryApiCall(async () => {
      const response = await httpGet(url, DEFAULT_HTTP_CONFIG);
      return response.data;
    }, context) || [];
  });
}

export {
  getShowByImdbId,
  getShowDetails,
  getShowEpisodes,
  getShowByTvdbId,
  searchShows,
  searchPeople,
  getPersonCastCredits,
  getShowById,
  getFullSchedule
};

// CommonJS compatibility
module.exports = {
  getShowByImdbId,
  getShowDetails,
  getShowEpisodes,
  getShowByTvdbId,
  searchShows,
  searchPeople,
  getPersonCastCredits,
  getShowById,
  getFullSchedule
};
