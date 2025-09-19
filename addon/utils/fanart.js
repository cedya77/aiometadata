require("dotenv").config();
const FanartTvApi = require('fanart.tv-api');
const { cacheWrapGlobal } = require('../lib/getCache');

const clientCache = new Map();

/**
 * Gets a configured and initialized FanartTvApi client.
 * @param {object} config - The user's configuration object.
 * @returns {FanartTvApi|null} An initialized client, or null if no key is provided.
 */
function getFanartClient(config) {
  const apiKey = config.apiKeys?.fanart || process.env.FANART_API_KEY;
  //console.log(`[Fanart] Attempting to get client with API key ending in ...${process.env.FANART_API_KEY}`);
  //console.log(`[Fanart] Attempting to get client with API key ending in ...${apiKey}`);
  if (!apiKey) {
    return null;
  }
  //console.log(`[Fanart] Initializing client with API key ending in ...${apiKey.slice(-4)}`);

  if (clientCache.has(apiKey)) {
    return clientCache.get(apiKey);
  }

  try {
    const newClient = new FanartTvApi({
      apiKey: apiKey
    });

    clientCache.set(apiKey, newClient);
    //console.log(`[Fanart] Caching new client for API key ending in ...${apiKey.slice(-4)}`);
    return newClient;
  } catch (error) {
    console.error(`[Fanart] Failed to initialize client for key ending in ...${apiKey.slice(-4)}:`, error.message);
    return null;
  }
}


/**
 * Fetches the best background image (showbackground) for a TV series from Fanart.tv.
 */
async function getBestSeriesBackground(tvdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tvdbId) {
    return null;
  }

  const cacheKey = `fanart-api:series-background:${tvdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getShowImages(tvdbId);

      if (!images.showbackground || images.showbackground.length === 0) {
        return null;
      }
      const sortedBackgrounds = images.showbackground.sort((a, b) => parseInt(b.likes) - parseInt(a.likes));
      return sortedBackgrounds[0].url;
    } catch (error) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TVDB ID ${tvdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TVDB ID ${tvdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60); // Cache for 7 days - artwork rarely changes
}

/**
 * Fetches the best background image (moviebackground) for a movie from Fanart.tv.
 */
async function getBestMovieBackground(tmdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

  const cacheKey = `fanart-api:movie-background:${tmdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getMovieImages(tmdbId);
      if (!images.moviebackground || images.moviebackground.length === 0) {
        return null;
      }
      const sortedBackgrounds = images.moviebackground.sort((a, b) => parseInt(b.likes) - parseInt(a.likes));
      return sortedBackgrounds[0].url;
    } catch (error) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TMDB ID ${tmdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TMDB ID ${tmdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60); // Cache for 7 days
}

/**
 * Fetches the complete image object for a movie from Fanart.tv.
 * @param {string} tmdbId - The TMDB ID of the movie.
 * @param {object} config - The user's configuration object.
 * @returns {Promise<object|null>} The full image object, or null on failure.
 */
async function getMovieImages(tmdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

  const cacheKey = `fanart-api:movie-images:${tmdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      return await fanartClient.getMovieImages(tmdbId);
    } catch (error) {
      if (error.message && !error.message.includes("Not Found")) {
        console.error(`[Fanart] Error in getMovieImages for TMDB ID ${tmdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60); // Cache for 7 days
}

/**
 * Fetches the best poster image (movieposter) for a movie from Fanart.tv.
 */
async function getBestMoviePoster(tmdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

  const cacheKey = `fanart-api:movie-poster:${tmdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getMovieImages(tmdbId);
      if (!images.movieposter || images.movieposter.length === 0) {
        return null;
      }
      const sortedPosters = images.movieposter.sort((a, b) => parseInt(b.likes) - parseInt(a.likes));
      return sortedPosters[0].url;
    } catch (error) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TMDB ID ${tmdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TMDB ID ${tmdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60); // Cache for 7 days
}

/**
 * Fetches the best logo image (movielogo) for a movie from Fanart.tv.
 */

async function getBestMovieLogo(tmdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

  const cacheKey = `fanart-api:movie-logo:${tmdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getMovieImages(tmdbId);
      if (!images.hdmovielogo || images.hdmovielogo.length === 0) {
        return null;
      }
      const sortedLogos = images.hdmovielogo.sort((a, b) => parseInt(b.likes) - parseInt(a.likes));
      return sortedLogos[0].url;
    } catch (error) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TMDB ID ${tmdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TMDB ID ${tmdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60); // Cache for 7 days
}

/**
 * Fetches the best poster image (tvposter) for a series from Fanart.tv.
 */
async function getBestSeriesPoster(tvdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tvdbId) {
    return null;
  }

  const cacheKey = `fanart-api:series-poster:${tvdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getShowImages(tvdbId);
      if (!images.tvposter || images.tvposter.length === 0) {
        return null;
      }
      const sortedPosters = images.tvposter.sort((a, b) => parseInt(b.likes) - parseInt(a.likes));
      return sortedPosters[0].url;
    } catch (error) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TVDB ID ${tvdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TVDB ID ${tvdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60); // Cache for 7 days
}

/**
 * Fetches the best logo image (tvlogo) for a tv from Fanart.tv.
 */
async function getBestTVLogo(tvdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tvdbId) {
    return null;
  }

  const cacheKey = `fanart-api:series-logo:${tvdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getShowImages(tvdbId);
      if (!images.hdtvlogo || images.hdtvlogo.length === 0) {
        return null;
      }
      const sortedLogos = images.hdtvlogo.sort((a, b) => parseInt(b.likes) - parseInt(a.likes));
      return sortedLogos[0].url;
    } catch (error) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TVDB ID ${tvdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TVDB ID ${tvdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60); // Cache for 7 days
}

/**
 * Fetches the complete image object for a series from Fanart.tv.
 * @param {string} tvdbId - The TVDB ID of the series.
 * @param {object} config - The user's configuration object.
 * @returns {Promise<object|null>} The full image object, or null on failure.
 */
async function getShowImages(tvdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tvdbId) {
    return null;
  }

  const cacheKey = `fanart-api:series-images:${tvdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      return await fanartClient.getShowImages(tvdbId);
    } catch (error) {
      // We can be less verbose for 404s, as they are expected.
      if (error.message && !error.message.includes("Not Found")) {
        console.error(`[Fanart] Error in getShowImages for TVDB ID ${tvdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60); // Cache for 7 days
}

/**
 * Selects the best Fanart image by language (user's, then English, then any), using likes as tiebreaker.
 * @param {Array} images - Array of Fanart image objects (e.g., hdmovielogo, tvposter, etc.)
 * @param {object} config - The user's configuration object.
 * @param {string} key - The property for language (default: 'lang').
 * @returns {object|undefined} The best image object, or undefined if none.
 */
function selectFanartImageByLang(images, config, key = 'lang') {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  
  // If englishArtOnly is enabled, force English language selection
  const targetLang = config.artProviders?.englishArtOnly ? 'en' : (config.language?.split('-')[0]?.toLowerCase() || 'en');
  
  // Filter by target language, then English, then generic (00), then any
  let filtered = images.filter(img => img[key] === targetLang);
  if (filtered.length === 0) filtered = images.filter(img => img[key] === 'en');
  if (filtered.length === 0) filtered = images.filter(img => img[key] === '00');
  if (filtered.length === 0) filtered = images;
  //console.log(`[selectFanartImageByLang] Filtered images: ${JSON.stringify(filtered)}`);
  // Sort by likes descending (as int)
  filtered.sort((a, b) => parseInt(b.likes || '0') - parseInt(a.likes || '0'));
  return filtered[0];
}


module.exports = {
  getBestSeriesBackground,
  getBestMovieBackground,
  getBestSeriesPoster,
  getBestMoviePoster,
  getMovieImages,
  getShowImages,
  getBestMovieLogo,
  getBestTVLogo,
  selectFanartImageByLang,
};