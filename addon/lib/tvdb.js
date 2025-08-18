require('dotenv').config();
const { cacheWrapTvdbApi } = require('./getCache');
const { to3LetterCode } = require('./language-map');
const fetch = require('node-fetch');

const TVDB_API_URL = 'https://api4.thetvdb.com/v4';
const GLOBAL_TVDB_KEY = process.env.TVDB_API_KEY;
const TVDB_IMAGE_BASE = 'https://artworks.thetvdb.com/banners/images/';

const tokenCache = new Map();

async function getAuthToken(apiKey) {
  const key = apiKey || GLOBAL_TVDB_KEY;
  if (!key) {
    console.error('TVDB API Key is not configured.');
    return null;
  }

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
  const token = await getAuthToken(config.apiKeys?.tvdb);
  if (!token) return [];
  try {
    const response = await fetch(`${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=series`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error(`Error searching TVDB for series "${query}":`, error.message);
    return [];
  }
}

async function searchMovies(query, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb);
  if (!token) return [];
  try {
    const response = await fetch(`${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=movie`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error(`Error searching TVDB for series "${query}":`, error.message);
    return [];
  }
}

async function searchPeople(query, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb);
  if (!token) return [];
  try {
    const response = await fetch(`${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=person`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error(`Error searching TVDB for person "${query}":`, error.message);
    return [];
  }
}

async function getSeriesExtended(tvdbId, config) {
  return cacheWrapTvdbApi(`series-extended:${tvdbId}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb);
    if (!token) return null;

    const url = `${TVDB_API_URL}/series/${tvdbId}/extended?meta=translations`;
    try {
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!response.ok) return null;
      const data = await response.json();
      return data.data;
    } catch(error) {
      console.error(`Error fetching extended series data for TVDB ID ${tvdbId}:`, error.message);
      return null; 
    }
  });
}

async function getMovieExtended(tvdbId, config) {
  return cacheWrapTvdbApi(`movie-extended:${tvdbId}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb);
    if (!token) return null;

    const url = `${TVDB_API_URL}/movies/${tvdbId}/extended?meta=translations`;
    try {
      const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!response.ok) return null;
      const data = await response.json();
      return data.data;
    } catch(error) {
      console.error(`Error fetching extended series data for TVDB ID ${tvdbId}:`, error.message);
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
    const token = await getAuthToken(config.apiKeys?.tvdb);
    if (!token) return null;

    const url = `${TVDB_API_URL}/seasons/${seasonId}/extended`;
    
    try {
      const response = await fetch(url, { 
        headers: { 'Authorization': `Bearer ${token}` } 
      });
      
      if (!response.ok) {
        console.warn(`[TVDB Client] Request for season ${seasonId} failed with status: ${response.status}`);
        return null;
      }
      
      const data = await response.json();
      return data.data;

    } catch(error) {
      console.error(`Error fetching extended season data for TVDB Season ID ${seasonId}:`, error.message);
      return null; 
    }
  });
}

async function getAllGenres(config) {
  const token = await getAuthToken(config.apiKeys?.tvdb);
  if (!token) return [];
  try {
    const response = await fetch(`${TVDB_API_URL}/genres`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.data || [];
  } catch (error) {
    console.error(`[TVDB] Error fetching genres:`, error.message);
    return [];
  }
}

async function findByImdbId(imdbId, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb);
  if (!token || !imdbId) return null;

  try {
    const response = await fetch(`${TVDB_API_URL}/search/remoteid/${imdbId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) return null;
    
    const data = await response.json();
    const match = data.data?.[0]; 

    if (match) {
        console.log(`[TVDB] Found match for remote ID ${imdbId}: TVDB ID ${match.id} (Type: ${match.type})`);
        return match;
    }
    return null;
  } catch (error) {
    console.error(`[TVDB] Error in findByImdbId for ${imdbId}:`, error.message);
    return null;
  }
}

async function getPersonExtended(personId, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb);
  if (!token) return null;
  try {
    const response = await fetch(`${TVDB_API_URL}/people/${personId}/extended`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data;
  } catch(error) {
    console.error(`Error fetching extended person data for Person ID ${personId}:`, error.message);
    return null;
  }
}

async function _fetchEpisodesBySeasonType(tvdbId, seasonType, language, config) {
  const token = await getAuthToken(config.apiKeys?.tvdb);
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
  const token = await getAuthToken(config.apiKeys?.tvdb);
  if (!token) return [];

  try {
    const queryParams = new URLSearchParams(params);
    const url = `${TVDB_API_URL}/${type}/filter?${queryParams.toString()}`;
    console.log(`[TVDB] request to: ${url}`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    if (!response.ok) {
      console.error(`[TVDB] Filter request failed with status: ${response.status}`);
      return [];
    }

    const data = await response.json();
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

module.exports = {
  searchSeries,
  searchMovies,
  searchPeople,
  getSeriesExtended,
  getMovieExtended,
  getPersonExtended,
  getSeriesEpisodes,
  findByImdbId,
  getAllGenres,
  filter,
  getSeasonExtended,
  getSeriesPoster,
  getSeriesBackground,
  getMoviePoster,
  getMovieBackground,
  getSeriesLogo,
  getMovieLogo
};
