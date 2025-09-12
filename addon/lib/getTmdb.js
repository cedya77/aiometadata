const { fetch, Agent } = require('undici');
const { socksDispatcher } = require('fetch-socks');
const { scrapeSingleImdbResultByTitle } = require('./imdb');
const consola = require('consola');

const TMDB_API_URL = 'https://api.themoviedb.org/3';

/**
 * Selects the best TMDB image by language (user's, then English, then any)
 * @param {Array} images - Array of TMDB image objects
 * @param {object} config - The user's configuration object
 * @returns {object|undefined} The best image object, or undefined if none
 */
function selectTmdbImageByLang(images, config) {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  
  // If englishArtOnly is enabled, force English language selection
  const targetLang = config.artProviders?.englishArtOnly ? 'en' : (config.language?.split('-')[0]?.toLowerCase() || 'en');
  
  let filtered = images.filter(img => img.iso_639_1 === targetLang);
  if (filtered.length === 0) filtered = images.filter(img => img.iso_639_1 === 'en');
  if (filtered.length === 0) filtered = images;
  
  filtered.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
  
  return filtered[0];
}

const SOCKS_PROXY_URL = process.env.TMDB_SOCKS_PROXY_URL;
let dispatcher;

if (SOCKS_PROXY_URL) {
  try {
    const proxyUrlObj = new URL(SOCKS_PROXY_URL);
    if (proxyUrlObj.protocol === 'socks5:' || proxyUrlObj.protocol === 'socks4:') {
      dispatcher = socksDispatcher({
        type: proxyUrlObj.protocol === 'socks5:' ? 5 : 4,
        host: proxyUrlObj.hostname,
        port: parseInt(proxyUrlObj.port),
        userId: proxyUrlObj.username,
        password: proxyUrlObj.password,
      });
      console.log(`[TMDB] SOCKS proxy is enabled for undici via fetch-socks.`);
    } else {
      console.error(`[TMDB] Unsupported proxy protocol: ${proxyUrlObj.protocol}. Using direct connection.`);
      dispatcher = new Agent({ connect: { timeout: 10000 } });
    }
  } catch (error) {
    console.error(`[TMDB] Invalid SOCKS_PROXY_URL. Using direct connection. Error: ${error.message}`);
    dispatcher = new Agent({ connect: { timeout: 10000 } });
  }
} else {
  dispatcher = new Agent({ connect: { timeout: 10000 } });
  console.log('[TMDB] undici agent is enabled for direct connections.');
}

// A simple in-memory cache
// This cache will store { tmdbId: imdbId } pairs after a successful scrape.
// It prevents calling the scraper multiple times for the same TMDB ID within the same session.
const scrapedImdbIdCache = new Map();

async function makeTmdbRequest(endpoint, apiKey, params = {}, method = 'GET', body = null) {
  if (!apiKey) throw new Error("TMDB API key is required.");
  
  const queryForUrl = {};

  for (const key in params) {
    if (params[key] !== undefined) {
      queryForUrl[key] = params[key] === null ? null : String(params[key]);
    }
  }
  
  const queryParams = new URLSearchParams(queryForUrl);
  queryParams.append('api_key', apiKey);
  
  const url = `${TMDB_API_URL}${endpoint}?${queryParams.toString()}`;

  const startTime = Date.now();
  try {
    const response = await fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      dispatcher: dispatcher,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });

    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      // Track failed request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tmdb', responseTime, false);
      
      const errorBody = await response.json().catch(() => ({}));
      const errorMessage = errorBody.status_message || `Request failed with status ${response.status}`;
      console.error(`[TMDB] Request failed for ${endpoint}: ${errorMessage}`);
      throw new Error(errorMessage);
    }

    // Track successful request with rate limit headers
    const requestTracker = require('./requestTracker');
    const rateLimitHeaders = {
      limit: response.headers.get('x-ratelimit-limit'),
      remaining: response.headers.get('x-ratelimit-remaining'),
      reset: response.headers.get('x-ratelimit-reset')
    };
    requestTracker.trackProviderCall('tmdb', responseTime, true, rateLimitHeaders);
    
    const data = await response.json();
    const isMovieDetailEndpoint = endpoint.match(/^\/movie\/(\d+)$/);
    const currentTmdbId = isMovieDetailEndpoint ? isMovieDetailEndpoint[1] : null;
    const type = isMovieDetailEndpoint ? 'movie' : 'series';
    if (!data.imdb_id && currentTmdbId) {
        if (scrapedImdbIdCache.has(currentTmdbId)) {
            const cachedImdbId = scrapedImdbIdCache.get(currentTmdbId);
            data.imdb_id = cachedImdbId;
            if (!data.external_ids) data.external_ids = {};
            data.external_ids.imdb_id = cachedImdbId;
        } else { 
            console.log(`[TMDB] imdb_id in TMDB response: ${data.imdb_id}`);
            const titleForScraper = data.original_title || data.title || null;

            if (titleForScraper) {
                console.log(`[TMDB] Attempting to scrape IMDb for title: "${titleForScraper}"`);
                const imdbScrapedResult = await scrapeSingleImdbResultByTitle(titleForScraper, type);

                if (imdbScrapedResult && imdbScrapedResult.imdbId) {
                    const foundImdbId = imdbScrapedResult.imdbId;
                    data.imdb_id = foundImdbId;
                    if (!data.external_ids) {
                        data.external_ids = {};
                    }
                    data.external_ids.imdb_id = foundImdbId;

                    scrapedImdbIdCache.set(currentTmdbId, foundImdbId);
                    console.log(`[TMDB] IMDb ID found by scraper: ${foundImdbId}`);
                } else {
                    console.warn(`[TMDB] IMDb scraper returned no ID for title: "${titleForScraper}"`);
                }
            } else {
                console.warn(`[TMDB] 'original_title'/'title' is null skipping IMDb fallback`);
            }
        }
    } else if (data.imdb_id) {
      console.log(`[TMDB] IMDb ID already present (${data.imdb_id}); skipping fallback for endpoint: ${endpoint}`);
    }

    return data;
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tmdb', responseTime, false);
    
    throw new Error(`[TMDB] Request to ${endpoint} failed: ${error.message}`);
  }
}

const accountDetailsCache = new Map();
async function getAccountDetails(sessionId, apiKey) {
    if (!sessionId) throw new Error("Session ID is required for account actions.");
    if (accountDetailsCache.has(sessionId)) {
        return accountDetailsCache.get(sessionId);
    }
    const details = await makeTmdbRequest('/account', apiKey, { session_id: sessionId });
    if (details) {
        accountDetailsCache.set(sessionId, details);
    }
    return details;
}
function getApiKey(config) {
    const key = config.apiKeys?.tmdb || process.env.TMDB_API;
    if (!key) throw new Error("TMDB API key not found in config or environment.");
    return key;
}

async function movieInfo(params, config) {
  const { id, ...queryParams } = params;
  return makeTmdbRequest(`/movie/${id}`, getApiKey(config), queryParams);
}
async function tvInfo(params, config) {
  const { id, ...queryParams } = params;
  return makeTmdbRequest(`/tv/${id}`, getApiKey(config), queryParams);
}
async function searchMovie(params, config) {
  const startTime = Date.now();
  const query = params.query || 'unknown';
  consola.info(`[TMDB] Starting movie search for: "${query}"`);
  
  const result = await makeTmdbRequest('/search/movie', getApiKey(config), params);
  
  const searchTime = Date.now() - startTime;
  const resultCount = result?.results?.length || 0;
  consola.info(`[TMDB] Movie search completed in ${searchTime}ms, found ${resultCount} results`);
  
  return result;
}

async function searchTv(params, config) {
  const startTime = Date.now();
  const query = params.query || 'unknown';
  consola.info(`[TMDB] Starting TV search for: "${query}"`);
  
  const result = await makeTmdbRequest('/search/tv', getApiKey(config), params);
  
  const searchTime = Date.now() - startTime;
  const resultCount = result?.results?.length || 0;
  consola.info(`[TMDB] TV search completed in ${searchTime}ms, found ${resultCount} results`);
  
  return result;
}

async function discoverMovie(params, config) {
  return makeTmdbRequest('/discover/movie', getApiKey(config), params);
}

async function discoverTv(params, config) {
  return makeTmdbRequest('/discover/tv', getApiKey(config), params);
}

async function genreMovieList(params, config) {
  return makeTmdbRequest('/genre/movie/list', getApiKey(config), params);
}



async function requestToken(config) { 
  return makeTmdbRequest('/authentication/token/new', getApiKey(config));
}

async function sessionId(params, config) { 
  return makeTmdbRequest('/authentication/session/new', getApiKey(config), {}, 'POST', params);
}

async function accountFavoriteMovies(params, config) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/favorite/movies`, apiKey, params);
}

async function accountFavoriteTv(params, config) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/favorite/tv`, apiKey, params);
}

async function accountMovieWatchlist(params, config) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/watchlist/movies`, apiKey, params);
}

async function accountTvWatchlist(params, config) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/watchlist/tv`, apiKey, params);
}

async function getMovieCertifications(params, config) {
  const apiKey = getApiKey(config);
  return makeTmdbRequest(`/movie/${params.id}/release_dates`, apiKey, params);
}

async function getTvCertifications(params, config) {
  const apiKey = getApiKey(config);
  return makeTmdbRequest(`/tv/${params.id}/content_ratings`, apiKey, params);
}

async function getMovieWatchProviders(params, config) {
  const data = await makeTmdbRequest(`/movie/${params.id}/watch/providers`, getApiKey(config), params);
  if (data?.results) {
    const country = config.language.split('-')[1] || 'US';
    const countryProviders = data.results[country];
    
    if (countryProviders) {
      const providers = [];
      
      // Extract flatrate providers (subscription services)
      if (countryProviders.flatrate) {
        countryProviders.flatrate.forEach(provider => {
          providers.push({
            name: provider.provider_name,
            logo: provider.logo_path ? `https://image.tmdb.org/t/p/w500${provider.logo_path}` : null,
            id: provider.provider_id,
            type: 'flatrate',
            priority: provider.display_priority
          });
        });
      }
      
      // Extract buy providers (purchase options)
      if (countryProviders.buy) {
        countryProviders.buy.forEach(provider => {
          providers.push({
            name: provider.provider_name,
            logo: provider.logo_path ? `https://image.tmdb.org/t/p/w500${provider.logo_path}` : null,
            id: provider.provider_id,
            type: 'buy',
            priority: provider.display_priority
          });
        });
      }
      
      // Extract rent providers (rental options)
      if (countryProviders.rent) {
        countryProviders.rent.forEach(provider => {
          providers.push({
            name: provider.provider_name,
            logo: provider.logo_path ? `https://image.tmdb.org/t/p/w500${provider.logo_path}` : null,
            id: provider.provider_id,
            type: 'rent',
            priority: provider.display_priority
          });
        });
      }
      
      // Sort by priority (lower number = higher priority)
      providers.sort((a, b) => a.priority - b.priority);
      
      return {
        country,
        link: countryProviders.link,
        providers
      };
    }
  }
  return null;
}

async function getTvWatchProviders(params, config) {
  const data = await makeTmdbRequest(`/tv/${params.id}/watch/providers`, getApiKey(config), params);
  if (data?.results) {
    const country = config.language.split('-')[1] || 'US';
    const countryProviders = data.results[country];
    
    if (countryProviders) {
      const providers = [];
      
      // Extract flatrate providers (subscription services)
      if (countryProviders.flatrate) {
        countryProviders.flatrate.forEach(provider => {
          providers.push({
            name: provider.provider_name,
            logo: provider.logo_path ? `https://image.tmdb.org/t/p/w500${provider.logo_path}` : null,
            id: provider.provider_id,
            type: 'flatrate',
            priority: provider.display_priority
          });
        });
      }
      
      // Extract buy providers (purchase options)
      if (countryProviders.buy) {
        countryProviders.buy.forEach(provider => {
          providers.push({
            name: provider.provider_name,
            logo: provider.logo_path ? `https://image.tmdb.org/t/p/w500${provider.logo_path}` : null,
            id: provider.provider_id,
            type: 'buy',
            priority: provider.display_priority
          });
        });
      }
      
      // Extract rent providers (rental options)
      if (countryProviders.rent) {
        countryProviders.rent.forEach(provider => {
          providers.push({
            name: provider.provider_name,
            logo: provider.logo_path ? `https://image.tmdb.org/t/p/w500${provider.logo_path}` : null,
            id: provider.provider_id,
            type: 'rent',
            priority: provider.display_priority
          });
        });
      }
      
      // Sort by priority (lower number = higher priority)
      providers.sort((a, b) => a.priority - b.priority);
      
      return {
        country,
        link: countryProviders.link,
        providers
      };
    }
  }
  return null;
}

async function getMovieTranslations(tmdbId, language, config) {
  const data = await makeTmdbRequest(`/movie/${tmdbId}/translations`, getApiKey(config));
  if (data?.translations) {
    const iso639 = language.split('-')[0];
    const iso3166 = language.split('-')[1];
    const translation = data.translations.find(t => t.iso_639_1 === iso639 && t.iso_3166_1 === iso3166);
    if (translation) {
      return translation;
    }
    return null;
  }
  return null;
}

async function getTvTranslations(tmdbId, language, config) {
  const data = await makeTmdbRequest(`/tv/${tmdbId}/translations`, getApiKey(config));
  if (data?.translations) {
    const iso639 = language.split('-')[0];
    const iso3166 = language.split('-')[1];
    const translation = data.translations.find(t => t.iso_639_1 === iso639 && t.iso_3166_1 === iso3166);
    if (translation) {
      return translation;
    }
    return null;
  }
  return null;
}

/**
 * Get TMDB movie poster URL
 * @param {string} tmdbId - TMDB movie ID
 * @param {string} mediaType - Media type ('movie' or 'series')
 * @param {Object} config - Configuration object
 * @returns {Promise<string|null>} Poster URL or null if not found
 */
async function getTmdbMoviePoster(tmdbId, config) {
  if (!tmdbId) return null;
  
  try {
    const apiKey = getApiKey(config);
    const images = await makeTmdbRequest(`/movie/${tmdbId}/images`, apiKey, {});
    
    if (images && images.posters && images.posters.length > 0) {
      const poster = selectTmdbImageByLang(images.posters, config);
      if (poster) {
        return `https://image.tmdb.org/t/p/w600_and_h900_bestv2${poster.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    console.warn(`[TMDB] Failed to get movie poster for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

/**
 * Get TMDB series poster URL
 * @param {string} tmdbId - TMDB series ID
 * @param {string} mediaType - Media type ('movie' or 'series')
 * @param {Object} config - Configuration object
 * @returns {Promise<string|null>} Poster URL or null if not found
 */
async function getTmdbSeriesPoster(tmdbId, config) {
  if (!tmdbId) return null;
  
  try {
    const apiKey = getApiKey(config);
    const images = await makeTmdbRequest(`/tv/${tmdbId}/images`, apiKey, {});
    
    if (images && images.posters && images.posters.length > 0) {
      const poster = selectTmdbImageByLang(images.posters, config);
      if (poster) {
        return `https://image.tmdb.org/t/p/w600_and_h900_bestv2${poster.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    console.warn(`[TMDB] Failed to get series poster for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

/**
 * Get TMDB movie background URL
 * @param {string} tmdbId - TMDB movie ID
 * @param {Object} config - Configuration object
 * @returns {Promise<string|null>} Background URL or null if not found
 */
async function getTmdbMovieBackground(tmdbId, config) {
  if (!tmdbId) return null;
  
  try {
    const apiKey = getApiKey(config);
    const images = await makeTmdbRequest(`/movie/${tmdbId}/images`, apiKey, {});
    
    if (images && images.backdrops && images.backdrops.length > 0) {
      const backdrop = selectTmdbImageByLang(images.backdrops, config);
      if (backdrop) {
        return `https://image.tmdb.org/t/p/original${backdrop.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    console.warn(`[TMDB] Failed to get movie background for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

/**
 * Get TMDB series background URL
 * @param {string} tmdbId - TMDB series ID
 * @param {Object} config - Configuration object
 * @returns {Promise<string|null>} Background URL or null if not found
 */
async function getTmdbSeriesBackground(tmdbId, config) {
  if (!tmdbId) return null;
  
  try {
    const apiKey = getApiKey(config);
    const images = await makeTmdbRequest(`/tv/${tmdbId}/images`, apiKey, {});
    
    if (images && images.backdrops && images.backdrops.length > 0) {
      const backdrop = selectTmdbImageByLang(images.backdrops, config);
      if (backdrop) {
        return `https://image.tmdb.org/t/p/original${backdrop.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    console.warn(`[TMDB] Failed to get series background for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

/**
 * Get TMDB movie logo URL
 * @param {string} tmdbId - TMDB movie ID
 * @param {Object} config - Configuration object
 * @returns {Promise<string|null>} Logo URL or null if not found
 */
async function getTmdbMovieLogo(tmdbId, config) {
  if (!tmdbId) return null;
  
  try {
    const apiKey = getApiKey(config);
    const images = await makeTmdbRequest(`/movie/${tmdbId}/images`, apiKey, {});
    
    if (images && images.logos && images.logos.length > 0) {
      const logo = selectTmdbImageByLang(images.logos, config);
      if (logo) {
        return `https://image.tmdb.org/t/p/original${logo.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    console.warn(`[TMDB] Failed to get movie logo for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

/**
 * Get TMDB series logo URL
 * @param {string} tmdbId - TMDB series ID
 * @param {Object} config - Configuration object
 * @returns {Promise<string|null>} Logo URL or null if not found
 */
async function getTmdbSeriesLogo(tmdbId, config) {
  if (!tmdbId) return null;
  
  try {
    const apiKey = getApiKey(config);
    const images = await makeTmdbRequest(`/tv/${tmdbId}/images`, apiKey, {});
    
    if (images && images.logos && images.logos.length > 0) {
      const logo = selectTmdbImageByLang(images.logos, config);
      if (logo) {
        return `https://image.tmdb.org/t/p/original${logo.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    console.warn(`[TMDB] Failed to get series logo for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

module.exports = {
  makeTmdbRequest, 
  movieInfo,
  tvInfo,
  searchMovie,
  searchTv,
  searchPerson: async (params, config) => {
    const startTime = Date.now();
    const query = params.query || 'unknown';
    consola.info(`[TMDB] Starting person search for: "${query}"`);
    
    const result = await makeTmdbRequest('/search/person', getApiKey(config), params);
    
    const searchTime = Date.now() - startTime;
    const resultCount = result?.results?.length || 0;
    consola.info(`[TMDB] Person search completed in ${searchTime}ms, found ${resultCount} results`);
    
    return result;
  },
  find: (params, config) => makeTmdbRequest(`/find/${params.id}`, getApiKey(config), { external_source: params.external_source }),
  languages: (config) => makeTmdbRequest('/configuration/languages', getApiKey(config)),
  primaryTranslations: (config) => makeTmdbRequest('/configuration/primary_translations', getApiKey(config)),
  discoverMovie,
  discoverTv,
  personMovieCredits: (params, config) => makeTmdbRequest(`/person/${params.id}/movie_credits`, getApiKey(config), params),
  personTvCredits: (params, config) => makeTmdbRequest(`/person/${params.id}/tv_credits`, getApiKey(config), params),
  seasonInfo: (params, config) => makeTmdbRequest(`/tv/${params.id}/season/${params.season_number}`, getApiKey(config), params),
  trending: (params, config) => makeTmdbRequest(`/trending/${params.media_type}/${params.time_window}`, getApiKey(config), params),
  movieImages: (params, config) => makeTmdbRequest(`/movie/${params.id}/images`, getApiKey(config), params),
  tvImages: (params, config) => makeTmdbRequest(`/tv/${params.id}/images`, getApiKey(config), params),
  genreMovieList,
  genreTvList: (params, config) => makeTmdbRequest('/genre/tv/list', getApiKey(config), params),
  requestToken,
  sessionId,
  accountFavoriteMovies,
  accountFavoriteTv,
  accountMovieWatchlist,
  accountTvWatchlist,
  getMovieCertifications,
  getTvCertifications,
  getTmdbMoviePoster,
  getTmdbSeriesPoster,
  getTmdbMovieBackground,
  getTmdbSeriesBackground,
  getTmdbMovieLogo,
  getTmdbSeriesLogo,
  getMovieWatchProviders,
  getTvWatchProviders,
  getMovieTranslations,
  getTvTranslations
};