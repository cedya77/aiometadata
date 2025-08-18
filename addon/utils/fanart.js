require("dotenv").config();
const FanartTvApi = require('fanart.tv-api');

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
}

/**
 * Fetches the best background image (moviebackground) for a movie from Fanart.tv.
 */
async function getBestMovieBackground(tmdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

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
  try {
    return await fanartClient.getMovieImages(tmdbId);
  } catch (error) {
    if (error.message && !error.message.includes("Not Found")) {
      console.error(`[Fanart] Error in getMovieImages for TMDB ID ${tmdbId}:`, error.message);
    }
    return null;
  }
}

/**
 * Fetches the best poster image (movieposter) for a movie from Fanart.tv.
 */
async function getBestMoviePoster(tmdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

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
}

/**
 * Fetches the best logo image (movielogo) for a movie from Fanart.tv.
 */

async function getBestMovieLogo(tmdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

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
}

/**
 * Fetches the best poster image (tvposter) for a series from Fanart.tv.
 */
async function getBestSeriesPoster(tvdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tvdbId) {
    return null;
  }

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
}

/**
 * Fetches the best logo image (tvlogo) for a tv from Fanart.tv.
 */
async function getBestTVLogo(tvdbId, config) {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tvdbId) {
    return null;
  }

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
  try {
    return await fanartClient.getShowImages(tvdbId);
  } catch (error) {
    // We can be less verbose for 404s, as they are expected.
    if (error.message && !error.message.includes("Not Found")) {
      console.error(`[Fanart] Error in getShowImages for TVDB ID ${tvdbId}:`, error.message);
    }
    return null;
  }
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
};