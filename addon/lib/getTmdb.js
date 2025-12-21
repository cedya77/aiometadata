const { fetch, Agent } = require('undici');
const { socksDispatcher } = require('fetch-socks');
const { scrapeSingleImdbResultByTitle, getMetaFromImdbIo } = require('./imdb');
const requestTracker = require('./requestTracker');
const consola = require('consola');
var nameToImdb = require("name-to-imdb");
const timingMetrics = require('./timing-metrics');
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
      consola.info(`[TMDB] SOCKS proxy is enabled for undici via fetch-socks.`);
    } else {
      consola.error(`[TMDB] Unsupported proxy protocol: ${proxyUrlObj.protocol}. Using direct connection.`);
      dispatcher = new Agent({ connect: { timeout: 10000 } });
    }
  } catch (error) {
    consola.error(`[TMDB] Invalid SOCKS_PROXY_URL. Using direct connection. Error: ${error.message}`);
    dispatcher = new Agent({ connect: { timeout: 10000 } });
  }
} else {
  dispatcher = new Agent({ connect: { timeout: 10000 } });
  consola.info('[TMDB] undici agent is enabled for direct connections.');
}

// A simple in-memory cache
// This cache will store { tmdbId: imdbId } pairs after a successful scrape.
// It prevents calling the scraper multiple times for the same TMDB ID within the same session.
const scrapedImdbIdCache = new Map();

async function makeTmdbRequest(endpoint, apiKey, params = {}, method = 'GET', body = null, config = {}) {
  if (!apiKey) throw new Error("TMDB API key is required.");
  
  const queryParams = new URLSearchParams(params);
  queryParams.append('api_key', apiKey);
  const url = `${TMDB_API_URL}${endpoint}?${queryParams.toString()}`;
  //console.log(`[TMDB] Making request to ${url}`);

  let attempt = 0;
  const maxRetries = 3;
  let lastError;

  while(attempt < maxRetries) {
    attempt++;
    const startTime = Date.now();
    
    // *** FIX 1: The 'try' block now wraps the entire attempt. ***
    try {
      const response = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        dispatcher: dispatcher,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      });

      const responseTime = Date.now() - startTime;

      if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
          const waitTime = retryAfter * 1000 + 50;
          consola.warn(`[TMDB] Rate limit hit for ${endpoint}. Waiting ${waitTime}ms.`);
          
          // Throw a specific error to be caught by the catch block for retrying
          const rateLimitError = new Error(`Rate limit hit (429)`);
          rateLimitError.isRetryable = true;
          rateLimitError.retryDelay = waitTime;
          throw rateLimitError;
      }

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const errorMessage = errorBody.status_message || `Request failed with status ${response.status}`;
        
        // Handle 404 errors gracefully - resource not found
        if (response.status === 404) {
          consola.warn(`[TMDB] Resource not found for ${endpoint}: ${errorMessage}`);
          return null; // Return null instead of throwing for 404s
        }
        
        throw new Error(errorMessage); // This will be caught by the catch block below
      }

      // Track successful request with rate limit headers
      const rateLimitHeaders = {
        limit: response.headers.get('x-ratelimit-limit'),
        remaining: response.headers.get('x-ratelimit-remaining'),
        reset: response.headers.get('x-ratelimit-reset')
      };
      requestTracker.trackProviderCall('tmdb', responseTime, true, rateLimitHeaders);
      
      const data = await response.json();
      const isMovieDetailEndpoint = endpoint.match(/^\/movie\/(\d+)$/);
      const currentTmdbId = isMovieDetailEndpoint ? isMovieDetailEndpoint[1] : null;
      const isSeriesDetailEndpoint = endpoint.match(/^\/tv\/(\d+)$/);
      const type = isMovieDetailEndpoint ? 'movie' : isSeriesDetailEndpoint ? 'series' : null;
      let nameToImdbTitle = data.original_title || data.title;
      if (!data.imdb_id && currentTmdbId && type && data.release_date) {
          const startTime = Date.now();
          if (data.translations) {
            consola.debug('Processing translations for:', data.original_title || data.title);
            // Lazy-load to avoid circular dependency with parseProps
            const Utils = require('../utils/parseProps');
            const translation = Utils.processTitleTranslations(data.translations, 'en-US', data.original_title, type);
            if (translation && translation.trim() !== '') {
              nameToImdbTitle = translation;
            }
          }
          const imdbSearchResult = await new Promise((resolve) => {
            nameToImdb(
              {
                name: nameToImdbTitle || "",
                type: type,
                year: data.release_date.substring(0, 4),
                strict: true
              },
              (err, result) => {
                if (err) {
                  consola.warn(`[TMDB] Failed to get IMDB ID for season name "${nameToImdbTitle}":`, err);
                  resolve(null);
                } else {
                  consola.debug(`[TMDB] IMDB ID found for name "${nameToImdbTitle}" and year "${data.release_date ? data.release_date.substring(0, 4) : ""}":`, result);
                  resolve(result);
                }
              }
            );
          });
          const duration = Date.now() - startTime;
          timingMetrics.recordTiming('nameToImdb_lookup', duration, { 
            type, 
            title: data.original_title || data.title,
            year: data.release_date ? data.release_date.substring(0, 4) : '',
            success: !!imdbSearchResult
          });
          consola.debug(`[TMDB] nameToImdb lookup took ${duration}ms for "${nameToImdbTitle}" (${type})`);
          if (imdbSearchResult) {
              data.imdb_id = imdbSearchResult;
              if (!data.external_ids) data.external_ids = {};
              data.external_ids.imdb_id = imdbSearchResult;
              consola.debug(`[TMDB] Successfully found IMDb ID: ${imdbSearchResult} for "${data.original_title || data.title}"`);
          } else {
              consola.debug(`[TMDB] No IMDb ID found for "${data.original_title || data.title}" (${type})`);
          }
      }

      if (!data.imdb_id && currentTmdbId && type && config?.tmdb?.scrapeImdb) {
          if (scrapedImdbIdCache.has(currentTmdbId)) {
              const cachedImdbId = scrapedImdbIdCache.get(currentTmdbId);
              data.imdb_id = cachedImdbId;
              if (!data.external_ids) data.external_ids = {};
              data.external_ids.imdb_id = cachedImdbId;
          } else { 
              consola.debug(`[TMDB] imdb_id in TMDB response: ${data.imdb_id}`);
              const titleForScraper = data.original_title || data.title || null;

              if (titleForScraper) {
                  consola.debug(`[TMDB] Attempting to scrape IMDb for title: "${titleForScraper}"`);
                  const scrapeStartTime = Date.now();
                  const imdbScrapedResult = await scrapeSingleImdbResultByTitle(titleForScraper, type);
                  

                  if (imdbScrapedResult && imdbScrapedResult.imdbId) {
                      const foundImdbId = imdbScrapedResult.imdbId;
                      const foundImdbMeta = await getMetaFromImdbIo(foundImdbId, type);
                      if (!foundImdbMeta) {
                          consola.warn(`[TMDB] IMDb ID ${foundImdbId} type mismatch. returning data without IMDb ID.`);
                          return data;
                      } else {
                        if (foundImdbMeta.releaseInfo?.includes('-') && type === 'movie') {
                          consola.warn(`[TMDB] IMDb ID ${foundImdbId} has a runtime that includes a dash. returning data without IMDb ID.`);
                          return data;
                        }
                      }
                      data.imdb_id = foundImdbId;
                      if (!data.external_ids) {
                          data.external_ids = {};
                      }
                      data.external_ids.imdb_id = foundImdbId;

                      scrapedImdbIdCache.set(currentTmdbId, foundImdbId);
                      const scrapeDuration = Date.now() - scrapeStartTime;
                  
                  // Record timing metrics for IMDb scraping
                      timingMetrics.recordTiming('imdb_scrape_lookup', scrapeDuration, { 
                        type, 
                        title: titleForScraper,
                        success: !!(imdbScrapedResult && imdbScrapedResult.imdbId),
                        method: 'scrape'
                      });
                      
                      consola.debug(`[TMDB] IMDb scraping took ${scrapeDuration}ms for "${titleForScraper}" (${type})`);
                      consola.debug(`[TMDB] IMDb ID found by scraper: ${foundImdbId}`);
                  } else {
                      consola.warn(`[TMDB] IMDb scraper returned no ID for title: "${titleForScraper}"`);
                  }
              } else {
                  consola.warn(`[TMDB] 'original_title'/'title' is null skipping IMDb fallback`);
              }
          }
      } else if (data.imdb_id) {
        consola.debug(`[TMDB] IMDb ID already present (${data.imdb_id}); skipping fallback for endpoint: ${endpoint}`);
      }

      return data;
    } catch (error) {
      lastError = error;
      const responseTime = Date.now() - startTime;
      requestTracker.trackProviderCall('tmdb', responseTime, false);
      
      // Check for custom retry delay from our 429 logic
      const delay = error.retryDelay || (1000 * Math.pow(2, attempt - 1));

      // Decide if we should retry
      if (attempt < maxRetries && (error.isRetryable || (typeof error.code === 'string' && error.code.startsWith('UND_ERR_')))) {
        consola.debug(`[TMDB] Request to ${endpoint} failed. Retrying in ${delay}ms (attempt ${attempt}/${maxRetries}). Error: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw lastError;
      }
    }
  }
}

const accountDetailsCache = new Map();
async function getAccountDetails(sessionId, apiKey) {
    if (!sessionId) throw new Error("Session ID is required for account actions.");
    if (accountDetailsCache.has(sessionId)) {
        return accountDetailsCache.get(sessionId);
    }
    const details = await makeTmdbRequest('/account', apiKey, { session_id: sessionId }, 'GET', null, {});
    if (details) {
        accountDetailsCache.set(sessionId, details);
    }
    return details;
}
function getApiKey(config) {
    const key = config.apiKeys?.tmdb || process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY;
    if (!key) throw new Error("TMDB API key not found in config or environment.");
    return key;
}

async function movieInfo(params, config) {
  const { id, ...queryParams } = params;
  return makeTmdbRequest(`/movie/${id}`, getApiKey(config), queryParams, 'GET', null, config);
}
async function tvInfo(params, config) {
  const { id, ...queryParams } = params;
  return makeTmdbRequest(`/tv/${id}`, getApiKey(config), queryParams, 'GET', null, config);
}

async function movieExternalIds(id, config) {
  return makeTmdbRequest(`/movie/${id}/external_ids`, getApiKey(config), { id }, 'GET', null, config);
}

async function tvExternalIds(id, config) {
  return makeTmdbRequest(`/tv/${id}/external_ids`, getApiKey(config), { id }, 'GET', null, config);
}

async function movieCredits(params, config) {
  const { id, ...queryParams } = params;
  return makeTmdbRequest(`/movie/${id}/credits`, getApiKey(config), queryParams, 'GET', null, config);
}

async function tvCredits(params, config) {
  const { id, ...queryParams } = params;
  return makeTmdbRequest(`/tv/${id}/credits`, getApiKey(config), queryParams, 'GET', null, config);
}

async function searchMovie(params, config) {
  const startTime = Date.now();
  const query = params.query || 'unknown';
  consola.info(`[TMDB] Starting movie search for: "${query}"`);
  
  const result = await makeTmdbRequest('/search/movie', getApiKey(config), params, 'GET', null, config);
  
  const searchTime = Date.now() - startTime;
  const resultCount = result?.results?.length || 0;
  consola.info(`[TMDB] Movie search completed in ${searchTime}ms, found ${resultCount} results`);
  
  return result;
}

async function searchTv(params, config) {
  const startTime = Date.now();
  const query = params.query || 'unknown';
  consola.info(`[TMDB] Starting TV search for: "${query}"`);
  
  const result = await makeTmdbRequest('/search/tv', getApiKey(config), params, 'GET', null, config);
  
  const searchTime = Date.now() - startTime;
  const resultCount = result?.results?.length || 0;
  consola.info(`[TMDB] TV search completed in ${searchTime}ms, found ${resultCount} results`);
  
  return result;
}

async function discoverMovie(params, config) {
  return makeTmdbRequest('/discover/movie', getApiKey(config), params, 'GET', null, config);
}

async function discoverTv(params, config) {
  return makeTmdbRequest('/discover/tv', getApiKey(config), params, 'GET', null, config);
}

async function genreMovieList(params, config) {
  return makeTmdbRequest('/genre/movie/list', getApiKey(config), params, 'GET', null, config);
}



async function requestToken(config) { 
  return makeTmdbRequest('/authentication/token/new', getApiKey(config), {}, 'GET', null, config);
}

async function sessionId(params, config) { 
  return makeTmdbRequest('/authentication/session/new', getApiKey(config), {}, 'POST', params, config);
}

async function accountFavoriteMovies(params, config) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/favorite/movies`, apiKey, params, 'GET', null, config);
}

async function accountFavoriteTv(params, config) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/favorite/tv`, apiKey, params, 'GET', null, config);
}

async function accountMovieWatchlist(params, config) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/watchlist/movies`, apiKey, params, 'GET', null, config);
}

async function accountTvWatchlist(params, config) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/watchlist/tv`, apiKey, params, 'GET', null, config);
}

async function getMovieCertifications(params, config) {
  const apiKey = getApiKey(config);
  return makeTmdbRequest(`/movie/${params.id}/release_dates`, apiKey, params, 'GET', null, config);
}

async function getTvCertifications(params, config) {
  const apiKey = getApiKey(config);
  return makeTmdbRequest(`/tv/${params.id}/content_ratings`, apiKey, params, 'GET', null, config);
}

async function getMovieWatchProviders(params, config) {
  const data = await makeTmdbRequest(`/movie/${params.id}/watch/providers`, getApiKey(config), params, 'GET', null, config);
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

function getWatchProviders(data, config) {
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

/**
 * Fetches ALL image types for a TMDB ID in a single API call.
 * This is our central helper.
 * @param {string} mediaType - 'movie' or 'tv'
 * @param {string} tmdbId - The TMDB ID
 * @param {object} config - The user config
 * @returns {Promise<{posters: Array, backdrops: Array, logos: Array}>}
 */
async function getTmdbImages(mediaType, tmdbId, config) {
  if (!tmdbId) return { posters: [], backdrops: [], logos: [] };
  try {
    const endpoint = `/${mediaType}/${tmdbId}/images`;
    // This makes ONE network request.
    const imagesData = await makeTmdbRequest(endpoint, getApiKey(config), {}, 'GET', null, config);
    return imagesData || { posters: [], backdrops: [], logos: [] };
  } catch (error) {
    consola.warn(`[TMDB] Failed to get images for ${mediaType} ${tmdbId}:`, error.message);
    return { posters: [], backdrops: [], logos: [] };
  }
}

async function getTvWatchProviders(params, config) {
  const data = await makeTmdbRequest(`/tv/${params.id}/watch/providers`, getApiKey(config), params, 'GET', null, config);
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

function getTranslations(translations, language) {
  if (translations?.translations) {
    const iso639 = language.split('-')[0];
    const iso3166 = language.split('-')[1];
    const translation = translations.translations.find(t => t.iso_639_1 === iso639 && t.iso_3166_1 === iso3166);
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
    const images = await makeTmdbRequest(`/movie/${tmdbId}/images`, apiKey, {}, 'GET', null, config);
    
    if (images && images.posters && images.posters.length > 0) {
      const poster = selectTmdbImageByLang(images.posters, config);
      if (poster) {
        return `https://image.tmdb.org/t/p/w600_and_h900_bestv2${poster.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    consola.warn(`[TMDB] Failed to get movie poster for TMDB ID ${tmdbId}:`, error.message);
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
    const images = await makeTmdbRequest(`/tv/${tmdbId}/images`, apiKey, {}, 'GET', null, config);
    
    if (images && images.posters && images.posters.length > 0) {
      const poster = selectTmdbImageByLang(images.posters, config);
      if (poster) {
        return `https://image.tmdb.org/t/p/w600_and_h900_bestv2${poster.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    consola.warn(`[TMDB] Failed to get series poster for TMDB ID ${tmdbId}:`, error.message);
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
    const images = await makeTmdbRequest(`/movie/${tmdbId}/images`, apiKey, {}, 'GET', null, config);
    
    if (images && images.backdrops && images.backdrops.length > 0) {
      const backdrop = selectTmdbImageByLang(images.backdrops, config);
      if (backdrop) {
        return `https://image.tmdb.org/t/p/original${backdrop.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    consola.warn(`[TMDB] Failed to get movie background for TMDB ID ${tmdbId}:`, error.message);
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
    const images = await makeTmdbRequest(`/tv/${tmdbId}/images`, apiKey, {}, 'GET', null, config);
    
    if (images && images.backdrops && images.backdrops.length > 0) {
      const backdrop = selectTmdbImageByLang(images.backdrops, config);
      if (backdrop) {
        return `https://image.tmdb.org/t/p/original${backdrop.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    consola.warn(`[TMDB] Failed to get series background for TMDB ID ${tmdbId}:`, error.message);
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
    const images = await makeTmdbRequest(`/movie/${tmdbId}/images`, apiKey, {}, 'GET', null, config);
    
    if (images && images.logos && images.logos.length > 0) {
      const logo = selectTmdbImageByLang(images.logos, config);
      if (logo) {
        return `https://image.tmdb.org/t/p/original${logo.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    consola.warn(`[TMDB] Failed to get movie logo for TMDB ID ${tmdbId}:`, error.message);
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
    const images = await makeTmdbRequest(`/tv/${tmdbId}/images`, apiKey, {}, 'GET', null, config);
    
    if (images && images.logos && images.logos.length > 0) {
      const logo = selectTmdbImageByLang(images.logos, config);
      if (logo) {
        return `https://image.tmdb.org/t/p/original${logo.file_path}`;
      }
    }
    
    return null;
  } catch (error) {
    consola.warn(`[TMDB] Failed to get series logo for TMDB ID ${tmdbId}:`, error.message);
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
    
    const result = await makeTmdbRequest('/search/person', getApiKey(config), params, 'GET', null, config);
    
    const searchTime = Date.now() - startTime;
    const resultCount = result?.results?.length || 0;
    consola.info(`[TMDB] Person search completed in ${searchTime}ms, found ${resultCount} results`);
    
    return result;
  },
  personInfo: async (params, config) => {
    const startTime = Date.now();
    const personId = params.id || 'unknown';
    consola.info(`[TMDB] Fetching person info for ID: ${personId}`);
    
    const result = await makeTmdbRequest(`/person/${personId}`, getApiKey(config), params, 'GET', null, config);
    
    const fetchTime = Date.now() - startTime;
    consola.info(`[TMDB] Person info fetched in ${fetchTime}ms`);
    
    return result;
  },
  find: (params, config) => makeTmdbRequest(`/find/${params.id}`, getApiKey(config), { external_source: params.external_source }, 'GET', null, config),
  languages: (config) => makeTmdbRequest('/configuration/languages', getApiKey(config), {}, 'GET', null, config),
  primaryTranslations: (config) => makeTmdbRequest('/configuration/primary_translations', getApiKey(config), {}, 'GET', null, config),
  discoverMovie,
  discoverTv,
  personMovieCredits: (params, config) => makeTmdbRequest(`/person/${params.id}/movie_credits`, getApiKey(config), params, 'GET', null, config),
  personTvCredits: (params, config) => makeTmdbRequest(`/person/${params.id}/tv_credits`, getApiKey(config), params, 'GET', null, config),
  seasonInfo: (params, config) => makeTmdbRequest(`/tv/${params.id}/season/${params.season_number}`, getApiKey(config), params, 'GET', null, config),
  trending: (params, config) => makeTmdbRequest(`/trending/${params.media_type}/${params.time_window}`, getApiKey(config), params, 'GET', null, config),
  movieImages: (params, config) => makeTmdbRequest(`/movie/${params.id}/images`, getApiKey(config), params, 'GET', null, config),
  tvImages: (params, config) => makeTmdbRequest(`/tv/${params.id}/images`, getApiKey(config), params, 'GET', null, config),
  genreMovieList,
  genreTvList: (params, config) => makeTmdbRequest('/genre/tv/list', getApiKey(config), params, 'GET', null, config),
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
  getTranslations,
  movieExternalIds,
  tvExternalIds,
  movieCredits,
  tvCredits,
  getTmdbImages,
  getWatchProviders
};