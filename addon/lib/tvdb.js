require('dotenv').config();
const { cacheWrapTvdbApi } = require('./getCache');
const { to3LetterCode } = require('./language-map');
const fetch = require('node-fetch');
const consola = require('consola');

const TVDB_API_URL = 'https://api4.thetvdb.com/v4';
const GLOBAL_TVDB_KEY = process.env.TVDB_API_KEY;
const TVDB_IMAGE_BASE = 'https://artworks.thetvdb.com/banners/images/';

const tokenCache = new Map(); // Global cache for self-hosted instances
const userTokenCaches = new Map(); // Per-user cache for public instances

async function getAuthToken(apiKey, userUUID = null) {
  const key = apiKey || GLOBAL_TVDB_KEY;
  if (!key) {
    console.error('TVDB API Key is not configured.');
    return null;
  }

  // For public instances (with userUUID), use per-user cache
  if (userUUID) {
    if (!userTokenCaches.has(userUUID)) {
      userTokenCaches.set(userUUID, new Map());
    }
    
    const userCache = userTokenCaches.get(userUUID);
    const cached = userCache.get(key);
    if (cached && Date.now() < cached.expiry) {
      return cached.token;
    }

    try {
      const response = await fetch(`${TVDB_API_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: key }),
      });
      if (!response.ok) {
        console.error(`Failed to get TVDB auth token for user ${userUUID} with key ...${key.slice(-4)}: ${response.statusText}`);
        return null;
      }
      const data = await response.json();
      const token = data.data.token;
      const expiry = Date.now() + (28 * 24 * 60 * 60 * 1000);
      
      userCache.set(key, { token, expiry });
      return token;
    } catch (error) {
      console.error(`Failed to get TVDB auth token for user ${userUUID} with key ...${key.slice(-4)}:`, error.message);
      return null;
    }
  }

  // For self-hosted instances (no userUUID), use global cache
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiry) {
    return cached.token;
  }

  try {
    const response = await fetch(`${TVDB_API_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: key }),
    });
    if (!response.ok) {
      console.error(`Failed to get TVDB auth token for key ...${key.slice(-4)}: ${response.statusText}`);
      return null;
    }
    const data = await response.json();
    const token = data.data.token;
    const expiry = Date.now() + (28 * 24 * 60 * 60 * 1000);
    
    tokenCache.set(key, { token, expiry });
    return token;
  } catch (error) {
    console.error(`Failed to get TVDB auth token for key ...${key.slice(-4)}:`, error.message);
    return null;
  }
}

async function searchSeries(query, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  
  const startTime = Date.now();
  consola.info(`[TVDB] Starting series search for: "${query}"`);
  
  try {
    const response = await fetch(`${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=series`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    consola.info(`[TVDB] Series search API call completed in ${responseTime}ms`);
    
    if (!response.ok) {
      // Track failed request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      consola.error(`[TVDB] Series search failed with status: ${response.status}`);
      return [];
    }
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const data = await response.json();
    const results = data.data || [];
    consola.info(`[TVDB] Series search returned ${results.length} results in ${responseTime}ms`);
    return results;
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    consola.error(`[TVDB] Series search error for "${query}" after ${responseTime}ms:`, error.message);
    return [];
  }
}

async function searchMovies(query, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  
  const startTime = Date.now();
  consola.info(`[TVDB] Starting movie search for: "${query}"`);
  
  try {
    const response = await fetch(`${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=movie`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    consola.info(`[TVDB] Movie search API call completed in ${responseTime}ms`);
    
    if (!response.ok) {
      // Track failed request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      consola.error(`[TVDB] Movie search failed with status: ${response.status}`);
      return [];
    }
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const data = await response.json();
    const results = data.data || [];
    consola.info(`[TVDB] Movie search returned ${results.length} results in ${responseTime}ms`);
    return results;
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    consola.error(`[TVDB] Movie search error for "${query}" after ${responseTime}ms:`, error.message);
    return [];
  }
}

async function searchPeople(query, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  
  const startTime = Date.now();
  consola.info(`[TVDB] Starting people search for: "${query}"`);
  
  try {
    const response = await fetch(`${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=person`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    consola.info(`[TVDB] People search API call completed in ${responseTime}ms`);
    
    if (!response.ok) {
      // Track failed request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      consola.error(`[TVDB] People search failed with status: ${response.status}`);
      return [];
    }
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const data = await response.json();
    const results = data.data || [];
    consola.info(`[TVDB] People search returned ${results.length} results in ${responseTime}ms`);
    return results;
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    consola.error(`[TVDB] People search error for "${query}" after ${responseTime}ms:`, error.message);
    return [];
  }
}

async function getSeriesExtended(tvdbId, config) {
  return cacheWrapTvdbApi(`series-extended:${tvdbId}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return null;

    const url = `${TVDB_API_URL}/series/${tvdbId}/extended?meta=translations`;
    const startTime = Date.now();
    
    try {
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      const responseTime = Date.now() - startTime;
      
      if (!response.ok) {
        // Track failed request
        const requestTracker = require('./requestTracker');
        requestTracker.trackProviderCall('tvdb', responseTime, false);
        return null;
      }
      
      // Track successful request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);
      
      const data = await response.json();
      return data.data;
    } catch(error) {
      // Track failed request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      
      console.error(`Error fetching extended series data for TVDB ID ${tvdbId}:`, error.message);
      return null; 
    }
  });
}

async function getMovieExtended(tvdbId, config) {
  return cacheWrapTvdbApi(`movie-extended:${tvdbId}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return null;

    const url = `${TVDB_API_URL}/movies/${tvdbId}/extended?meta=translations`;
    const startTime = Date.now();
    
    try {
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      const responseTime = Date.now() - startTime;
      
      if (!response.ok) {
        // Track failed request
        const requestTracker = require('./requestTracker');
        requestTracker.trackProviderCall('tvdb', responseTime, false);
        return null;
      }
      
      // Track successful request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);
      
      const data = await response.json();
      return data.data;
    } catch(error) {
      // Track failed request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      
      console.error(`Error fetching extended movie data for TVDB ID ${tvdbId}:`, error.message);
      return null; 
    }
  });
}

/**
 * Fetches the extended details for a single season from TVDB, including its episode list.
 * This is used to get an accurate episode count for building the season layout map.
 * The result is cached in Redis.
 *
 * @param {string|number} seasonId - The UNIQUE ID of the season (not its number).
 * @param {object} config - The addon's config object.
 * @returns {Promise<object|null>} The full season data object, or null on failure.
 */
async function getSeasonExtended(seasonId, config) {
  return cacheWrapTvdbApi(`season-extended:${seasonId}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return null;

    const url = `${TVDB_API_URL}/seasons/${seasonId}/extended`;
    const startTime = Date.now();
    
    try {
      const response = await fetch(url, { 
        headers: { 'Authorization': `Bearer ${token}` } 
      });
      
      const responseTime = Date.now() - startTime;
      
      if (!response.ok) {
        // Track failed request
        const requestTracker = require('./requestTracker');
        requestTracker.trackProviderCall('tvdb', responseTime, false);
        
        console.warn(`[TVDB Client] Request for season ${seasonId} failed with status: ${response.status}`);
        return null;
      }
      
      // Track successful request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);
      
      const data = await response.json();
      return data.data;

    } catch(error) {
      // Track failed request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      
      console.error(`Error fetching extended season data for TVDB Season ID ${seasonId}:`, error.message);
      return null; 
    }
  });
}

async function getAllGenres(config) {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) {
    console.error(`[TVDB] No auth token available for genres request`);
    return [];
  }
  
  const startTime = Date.now();
  try {
    console.log(`[TVDB] Fetching genres from: ${TVDB_API_URL}/genres`);
    const response = await fetch(`${TVDB_API_URL}/genres`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const responseTime = Date.now() - startTime;
    console.log(`[TVDB] Genres response status: ${response.status}`);
    
    if (!response.ok) {
      // Track failed request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      
      console.error(`[TVDB] Genres request failed with status: ${response.status}`);
      const errorText = await response.text();
      console.error(`[TVDB] Genres error response:`, errorText);
      return [];
    }
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const data = await response.json();
    console.log(`[TVDB] Genres response data structure:`, Object.keys(data));
    console.log(`[TVDB] Genres count: ${data.data ? data.data.length : 0}`);
    
    if (data.data && data.data.length > 0) {
      console.log(`[TVDB] First few genres:`, data.data.slice(0, 5).map(g => ({ id: g.id, name: g.name })));
    }
    
    return data.data || [];
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    console.error(`[TVDB] Error fetching genres:`, error.message);
    return [];
  }
}

async function findByImdbId(imdbId, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token || !imdbId) return null;

  const startTime = Date.now();
  try {
    const response = await fetch(`${TVDB_API_URL}/search/remoteid/${imdbId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const responseTime = Date.now() - startTime;
    
    if (!response.ok) {
      // Track failed request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      return null;
    }
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const data = await response.json();
    const match = data.data?.[0]; 

    if (match) {
        return match;
    }
    return null;
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    console.error(`[TVDB] Error in findByImdbId for ${imdbId}:`, error.message);
    return null;
  }
}

async function findByTmdbId(tmdbId, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return null;
  
  const startTime = Date.now();
  try {
    const response = await fetch(`${TVDB_API_URL}/search/remoteid/${tmdbId}`, { headers: { 'Authorization': `Bearer ${token}` } });
    
    const responseTime = Date.now() - startTime;
    
    if (!response.ok) {
      // Track failed request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      return null;
    }
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const data = await response.json();
    console.log(`[TVDB] findByTmdbId raw response for ${tmdbId}:`, JSON.stringify(data, null, 2));
    console.log(`[TVDB] findByTmdbId data.data:`, data.data);
    return data.data;
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    console.warn(`[TVDB] Error in findByTmdbId for ${tmdbId}:`, error.message);
    return null;
  }
}

async function getPersonExtended(personId, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return null;
  
  const startTime = Date.now();
  try {
    const response = await fetch(`${TVDB_API_URL}/people/${personId}/extended`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const responseTime = Date.now() - startTime;
    
    if (!response.ok) {
      // Track failed request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      return null;
    }
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const data = await response.json();
    return data.data;
  } catch(error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    console.error(`Error fetching extended person data for Person ID ${personId}:`, error.message);
    return null;
  }
}

async function _fetchEpisodesBySeasonType(tvdbId, seasonType, language, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return null;

  const langCode3 = await to3LetterCode(language.split('-')[0], config);
  
  let allEpisodes = [];
  let page = 0;
  let hasNextPage = true;

  while(hasNextPage) {
    const url = `${TVDB_API_URL}/series/${tvdbId}/episodes/${seasonType}/${langCode3}?page=${page}`;
    try {
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!response.ok) {
        console.warn(`[TVDB] API returned non-OK status for ${seasonType} episodes of ${tvdbId}.`);
        hasNextPage = false;
        continue;
      }
      const data = await response.json();
      if (data.data && data.data.episodes) {
        allEpisodes.push(...data.data.episodes);
      }
      hasNextPage = data.links && data.links.next;
      page++;
    } catch(error) {
      console.error(`Error fetching page ${page} of ${seasonType} episodes for TVDB ID ${tvdbId}:`, error.message);
      hasNextPage = false;
    }
  }
  return { episodes: allEpisodes };
}

async function getSeriesEpisodes(tvdbId, language = 'en-US', seasonType = 'default', config = {},  bypassCache = false) {
  const cacheKey = `series-episodes:${tvdbId}:${language}:${seasonType}`;

  return cacheWrapTvdbApi(cacheKey, async () => {
    console.log(`[TVDB] Fetching episodes for ${tvdbId} with type: '${seasonType}' and lang: '${language}'`);
    let result = await _fetchEpisodesBySeasonType(tvdbId, seasonType, language, config);
 
    if ((!result || result.episodes.length === 0) && seasonType !== 'official') {
      console.warn(`[TVDB] No episodes found for type '${seasonType}'. Falling back to 'official' order.`);
      result = await _fetchEpisodesBySeasonType(tvdbId, 'official', language, config);
    }

    if ((!result || result.episodes.length === 0) && language !== 'en-US') {
      console.warn(`[TVDB] No episodes found in '${language}'. Falling back to 'en-US'.`);
      return getSeriesEpisodes(tvdbId, 'en-US', seasonType, config, true); 
    }
    
    return result;
  }, bypassCache);
}

async function filter(type, params, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) {
    console.error(`[TVDB] No auth token available for filter request`);
    return [];
  }

  try {
    const queryParams = new URLSearchParams(params);
    const url = `${TVDB_API_URL}/${type}/filter?${queryParams.toString()}`;
    console.log(`[TVDB] Filter request to: ${url}`);
    console.log(`[TVDB] Filter params:`, JSON.stringify(params));
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`[TVDB] Filter response status: ${response.status}`);
    
    if (!response.ok) {
      console.error(`[TVDB] Filter request failed with status: ${response.status}`);
      const errorText = await response.text();
      console.error(`[TVDB] Filter error response:`, errorText);
      return [];
    }

    const data = await response.json();
    console.log(`[TVDB] Filter response data structure:`, Object.keys(data));
    console.log(`[TVDB] Filter response data.data length:`, data.data ? data.data.length : 'undefined');
    
    return data.data || [];
  } catch (error) {
    console.error(`[TVDB] Error in filter for ${type}:`, error.message);
    return [];
  }
}

/**
 * Get series poster from TVDB
 */
async function getSeriesPoster(tvdbId, config) {
  try {
    const seriesData = await getSeriesExtended(tvdbId, config);
    if (seriesData && seriesData.image) {
      return seriesData.image.startsWith('http') ? seriesData.image : `${TVDB_IMAGE_BASE}${seriesData.image}`;
    }
    return null;
  } catch (error) {
    console.error(`[TVDB] Error getting poster for series ${tvdbId}:`, error.message);
    return null;
  }
}

/**
 * Get series background from TVDB
 */
async function getSeriesBackground(tvdbId, config) {
  try {
    const seriesData = await getSeriesExtended(tvdbId, config);
    if (seriesData && seriesData.artworks) {
      // Look for background artwork (type 3 is typically background)
      const backgroundArtwork = seriesData.artworks.find(art => art.type === 3);
      if (backgroundArtwork && backgroundArtwork.image) {
        return backgroundArtwork.image.startsWith('http') ? backgroundArtwork.image : `${TVDB_IMAGE_BASE}${backgroundArtwork.image}`;
      }
    }
    return null;
  } catch (error) {
    console.error(`[TVDB] Error getting background for series ${tvdbId}:`, error.message);
    return null;
  }
}

/**
 * Get movie poster from TVDB
 */
async function getMoviePoster(tvdbId, config) {
  try {
    const movieData = await getMovieExtended(tvdbId, config);
    if (movieData && movieData.image) {
      return movieData.image.startsWith('http') ? movieData.image : `${TVDB_IMAGE_BASE}${movieData.image}`;
    }
    return null;
  } catch (error) {
    console.error(`[TVDB] Error getting poster for movie ${tvdbId}:`, error.message);
    return null;
  }
}

/**
 * Get movie background from TVDB
 */
async function getMovieBackground(tvdbId, config) {
  try {
    const movieData = await getMovieExtended(tvdbId, config);
    if (movieData && movieData.artworks) {
      // Look for background artwork (type 15 is background for movies)
      const backgroundArtwork = movieData.artworks.find(art => art.type === 15);
      if (backgroundArtwork && backgroundArtwork.image) {
        console.log(`[TVDB] Found movie background (type 15) for TVDB ID ${tvdbId}: ${backgroundArtwork.image}`);
        return backgroundArtwork.image.startsWith('http') ? backgroundArtwork.image : `${TVDB_IMAGE_BASE}${backgroundArtwork.image}`;
      }
      
      // Fallback to type 3 if type 15 not found
      const fallbackBackground = movieData.artworks.find(art => art.type === 3);
      if (fallbackBackground && fallbackBackground.image) {
        console.log(`[TVDB] Found movie background (type 3 fallback) for TVDB ID ${tvdbId}: ${fallbackBackground.image}`);
        return fallbackBackground.image.startsWith('http') ? fallbackBackground.image : `${TVDB_IMAGE_BASE}${fallbackBackground.image}`;
      }
      
      console.log(`[TVDB] No background artwork found for movie ${tvdbId}. Available types:`, movieData.artworks.map(art => art.type));
    }
    return null;
  } catch (error) {
    console.error(`[TVDB] Error getting background for movie ${tvdbId}:`, error.message);
    return null;
  }
}

/**
 * Get series logo from TVDB
 */
async function getSeriesLogo(tvdbId, config) {
  try {
    const seriesData = await getSeriesExtended(tvdbId, config);
    if (seriesData && seriesData.artworks) {
      // Look for clear logo artwork (type 23 is clear logo for series)
      const logoArtwork = seriesData.artworks.find(art => art.type === 23);
      if (logoArtwork && logoArtwork.image) {
        return logoArtwork.image.startsWith('http') ? logoArtwork.image : `${TVDB_IMAGE_BASE}${logoArtwork.image}`;
      }
    }
    return null;
  } catch (error) {
    console.error(`[TVDB] Error getting logo for series ${tvdbId}:`, error.message);
    return null;
  }
}

/**
 * Get movie logo from TVDB
 */
async function getMovieLogo(tvdbId, config) {
  try {
    const movieData = await getMovieExtended(tvdbId, config);
    if (movieData && movieData.artworks) {
      // Look for clear logo artwork (type 25 is clear logo for movies)
      const logoArtwork = movieData.artworks.find(art => art.type === 25);
      if (logoArtwork && logoArtwork.image) {
        return logoArtwork.image.startsWith('http') ? logoArtwork.image : `${TVDB_IMAGE_BASE}${logoArtwork.image}`;
      }
    }
    return null;
  } catch (error) {
    console.error(`[TVDB] Error getting logo for movie ${tvdbId}:`, error.message);
    return null;
  }
}

/**
 * Fetch all TVDB collections (lists)
 */
async function getCollectionsList(config, page = 0) {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  try {
    const url = `${TVDB_API_URL}/lists?page=${page}`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error(`[TVDB] Error fetching collections list:`, error.message);
    return [];
  }
}

/**
 * Fetch details for a specific TVDB collection (list)
 */
async function getCollectionDetails(collectionId, config) {
  return cacheWrapTvdbApi(`collection-details:${collectionId}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return null;
    try {
      const url = `${TVDB_API_URL}/lists/${collectionId}/extended`;
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!response.ok) return null;
      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error(`[TVDB] Error fetching collection details for ID ${collectionId}:`, error.message);
      return null;
    }
  });
}

/**
 * Fetch translations for a specific TVDB collection (list)
 */
async function getCollectionTranslations(collectionId, language, config) {
  return cacheWrapTvdbApi(`collection-translations:${collectionId}:${language}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return null;
    try {
      const url = `${TVDB_API_URL}/lists/${collectionId}/translations/${language}`;
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!response.ok) return null;
      const data = await response.json();
      return data.data;
    } catch (error) {
      console.error(`[TVDB] Error fetching collection translations for ID ${collectionId}, lang ${language}:`, error.message);
      return null;
    }
  });
}

module.exports = {
  searchSeries,
  searchMovies,
  searchPeople,
  getSeriesExtended,
  getMovieExtended,
  getPersonExtended,
  getSeriesEpisodes,
  findByImdbId,
  findByTmdbId,
  getAllGenres,
  filter,
  getSeasonExtended,
  getSeriesPoster,
  getSeriesBackground,
  getMoviePoster,
  getMovieBackground,
  getSeriesLogo,
  getMovieLogo,
  getCollectionsList,
  getCollectionDetails,
  getCollectionTranslations
};
