import { fetch, Agent, ProxyAgent } from 'undici';
import { socksDispatcher } from 'fetch-socks';
import { scrapeSingleImdbResultByTitle, getMetaFromImdbIo } from './imdb';
import requestTracker from './requestTracker';
import consola from 'consola';
import nameToImdb from "name-to-imdb";
import timingMetrics from './timing-metrics';
import { cacheWrapGlobal } from './getCache';
import { UserConfig } from '../types/index';

const TMDB_API_URL = 'https://api.themoviedb.org/3';

// HTTP status codes that should NOT be retried
const NON_RETRYABLE_CODES = new Set([400, 401, 403, 404, 422]);

interface TmdbImage {
  iso_639_1: string | null;
  file_path: string;
  vote_average: number;
}

/**
 * Selects the best TMDB image by language (O(N) optimized)
 * @param {Array} images - Array of TMDB image objects
 * @param {object} config - The user's configuration object
 * @returns {object|undefined} The best image object, or undefined if none
 */
function selectTmdbImageByLang(images: TmdbImage[] | undefined, config: UserConfig): TmdbImage | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;

  const englishArtOnly = (config.artProviders as any)?.englishArtOnly;
  const targetLang = englishArtOnly ? 'en' : (config.language?.split('-')[0]?.toLowerCase() || 'en');
  
  let best: TmdbImage | null = null;
  let fallbackEn: TmdbImage | null = null;
  let fallbackAny: TmdbImage | null = null;

  for (const img of images) {
     if (img.iso_639_1 === targetLang) {
         if (!best || (img.vote_average > best.vote_average)) best = img;
     } else if (img.iso_639_1 === 'en') {
         if (!fallbackEn || (img.vote_average > fallbackEn.vote_average)) fallbackEn = img;
     } else {
         // Keep the highest rated 'any' image as a last resort
         if (!fallbackAny || (img.vote_average > fallbackAny.vote_average)) fallbackAny = img;
     }
  }
  
  return best || fallbackEn || fallbackAny || undefined;
}

// TMDB dispatcher configuration
const SOCKS_PROXY_URL = process.env.TMDB_SOCKS_PROXY_URL;
const HTTP_PROXY_URL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
let dispatcher: any;

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
      console.error(`[TMDB] Unsupported proxy protocol: ${proxyUrlObj.protocol}. Falling back.`);
      dispatcher = null;
    }
  } catch (error: any) {
    console.error(`[TMDB] Invalid SOCKS_PROXY_URL. Falling back. Error: ${error.message}`);
    dispatcher = null;
  }
}

if (!dispatcher) {
  if (HTTP_PROXY_URL) {
    try {
      dispatcher = new ProxyAgent({ uri: new URL(HTTP_PROXY_URL).toString() });
      console.log('[TMDB] Using global HTTP proxy.');
    } catch (error: any) {
      console.error(`[TMDB] Invalid HTTP_PROXY URL. Using direct connection. Error: ${error.message}`);
      dispatcher = new Agent({ connect: { timeout: 10000 } });
    }
  } else {
    dispatcher = new Agent({ connect: { timeout: 10000 } });
    console.log('[TMDB] undici agent is enabled for direct connections.');
  }
}

// Simple cache for scraped IDs to avoid re-scraping
const scrapedImdbIdCache = new Map<string, string>();

interface TmdbRequestError extends Error {
    statusCode?: number;
    isRetryable?: boolean;
    retryDelay?: number;
}

async function makeTmdbRequest(endpoint: string, apiKey: string, params: Record<string, any> = {}, method = 'GET', body: any = null, config: UserConfig = {} as UserConfig): Promise<any> {
  if (!apiKey) throw new Error("TMDB API key is required.");
  
  const queryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
          queryParams.append(key, String(value));
      }
  }
  queryParams.append('api_key', apiKey);
  
  const url = `${TMDB_API_URL}${endpoint}?${queryParams.toString()}`;

  let attempt = 0;
  const maxRetries = 3;
  let lastError: any;

  // Periodic cleanup for the memory cache
  if (scrapedImdbIdCache.size > 10000) {
      scrapedImdbIdCache.clear();
      consola.debug('[TMDB] Scraped ID cache cleared (size limit reached)');
  }

  while(attempt < maxRetries) {
    attempt++;
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

      // Handle 429 specifically with backoff
      if (response.status === 429) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfter = parseInt(retryAfterHeader || '5', 10);
          const waitTime = retryAfter * 1000 + 50; // Add buffer
          
          const rateLimitError = new Error(`Rate limit hit (429)`) as TmdbRequestError;
          rateLimitError.isRetryable = true;
          rateLimitError.retryDelay = waitTime;
          rateLimitError.statusCode = 429;
          throw rateLimitError;
      }

      if (!response.ok) {
        // Fast fail for non-retryable errors (Auth, Bad Request, etc)
        if (NON_RETRYABLE_CODES.has(response.status)) {
             // Special handling for 404 - return null/empty instead of throwing if expected
             if (response.status === 404) {
                 consola.warn(`[TMDB] Resource not found for ${endpoint}`);
                 return null;
             }
             const errorBody: any = await response.json().catch(() => ({}));
             const errorMessage = errorBody.status_message || `Request failed with status ${response.status}`;
             const fatalError = new Error(errorMessage) as TmdbRequestError;
             fatalError.statusCode = response.status;
             throw fatalError;
        }
        
        // Retryable server errors (500, 502, etc)
        const errorBody: any = await response.json().catch(() => ({}));
        const errorMessage = errorBody.status_message || `Request failed with status ${response.status}`;
        throw new Error(errorMessage);
      }

      // Track successful request
      const rateLimitHeaders = {
        limit: response.headers.get('x-ratelimit-limit'),
        remaining: response.headers.get('x-ratelimit-remaining'),
        reset: response.headers.get('x-ratelimit-reset')
      };
      requestTracker.trackProviderCall('tmdb', responseTime, true, rateLimitHeaders as any);
      
      const data: any = await response.json();
      
      // --- IMDb ID Enrichment Logic ---
      const isMovieDetailEndpoint = endpoint.match(/^\/movie\/(\d+)$/);
      const currentTmdbId = isMovieDetailEndpoint ? isMovieDetailEndpoint[1] : null;
      const isSeriesDetailEndpoint = endpoint.match(/^\/tv\/(\d+)$/);
      const type = isMovieDetailEndpoint ? 'movie' : isSeriesDetailEndpoint ? 'series' : null;
      
      let nameToImdbTitle = data.original_title || data.title;
      
      // Strategy 1: NameToImdb Lookup
      if (!data.imdb_id && currentTmdbId && type && data.release_date) {
          const startTime = Date.now();
          if (data.translations) {
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
              (err: any, result: any) => resolve(err ? null : result)
            );
          });
          
          if (imdbSearchResult) {
              data.imdb_id = imdbSearchResult;
              if (!data.external_ids) data.external_ids = {};
              data.external_ids.imdb_id = imdbSearchResult;
          }
          
          const duration = Date.now() - startTime;
          timingMetrics.recordTiming('nameToImdb_lookup', duration, { type, success: !!imdbSearchResult });
      }

      // Strategy 2: Scraper Fallback
      if (!data.imdb_id && currentTmdbId && type && config?.tmdb?.scrapeImdb) {
          if (scrapedImdbIdCache.has(currentTmdbId)) {
              const cachedImdbId = scrapedImdbIdCache.get(currentTmdbId);
              data.imdb_id = cachedImdbId;
              if (!data.external_ids) data.external_ids = {};
              data.external_ids.imdb_id = cachedImdbId;
          } else { 
              const titleForScraper = data.original_title || data.title || null;

              if (titleForScraper) {
                  const scrapeStartTime = Date.now();
                  const imdbScrapedResult = await scrapeSingleImdbResultByTitle(titleForScraper, type);
                  
                  if (imdbScrapedResult && imdbScrapedResult.imdbId) {
                      const foundImdbId = imdbScrapedResult.imdbId;
                      // Verify scraped ID metadata to ensure match (prevent false positives)
                      const foundImdbMeta = await getMetaFromImdbIo(foundImdbId, type);
                      
                      let isValidMatch = true;
                      if (!foundImdbMeta) isValidMatch = false;
                      else if (foundImdbMeta.releaseInfo?.includes('-') && type === 'movie') isValidMatch = false; // TV movie vs Movie check

                      if (isValidMatch) {
                        data.imdb_id = foundImdbId;
                        if (!data.external_ids) data.external_ids = {};
                        data.external_ids.imdb_id = foundImdbId;
                        scrapedImdbIdCache.set(currentTmdbId, foundImdbId);
                      }
                      
                      timingMetrics.recordTiming('imdb_scrape_lookup', Date.now() - scrapeStartTime, { 
                        type, 
                        success: isValidMatch,
                        method: 'scrape'
                      });
                  }
              }
          }
      }

      return data;
    } catch (error: any) {
      lastError = error;
      const responseTime = Date.now() - startTime;
      requestTracker.trackProviderCall('tmdb', responseTime, false);
      
      // Check for non-retryable errors to exit loop early
      if (error.statusCode && NON_RETRYABLE_CODES.has(error.statusCode)) {
          throw error;
      }

      const delay = error.retryDelay || (1000 * Math.pow(2, attempt - 1));

      const isNetworkError = error.name === 'TypeError' && error.message === 'fetch failed';
      const isUndiciError = typeof error.code === 'string' && error.code.startsWith('UND_ERR_');
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';

      if (attempt < maxRetries && (error.isRetryable || isUndiciError || isNetworkError || isTimeout)) {
        consola.debug(`[TMDB] Request to ${endpoint} failed. Retrying in ${delay}ms (attempt ${attempt}/${maxRetries}). Error: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw lastError;
      }
    }
  }
}

const accountDetailsCache = new Map();
async function getAccountDetails(sessionId: string, apiKey: string) {
    if (!sessionId) throw new Error("Session ID is required for account actions.");
    if (accountDetailsCache.has(sessionId)) {
        return accountDetailsCache.get(sessionId);
    }
    const details = await makeTmdbRequest('/account', apiKey, { session_id: sessionId }, 'GET', null, {} as UserConfig);
    if (details) {
        accountDetailsCache.set(sessionId, details);
    }
    return details;
}
function getApiKey(config: UserConfig): string {
    const key = config.apiKeys?.tmdb || process.env.TMDB_API || process.env.BUILT_IN_TMDB_API_KEY;
    if (!key) throw new Error("TMDB API key not found in config or environment.");
    return key;
}

// --- Endpoints ---

// Cache language/translation data as it changes rarely (24h)
export async function languages(config: UserConfig) {
  return cacheWrapGlobal('tmdb:languages', () => 
    makeTmdbRequest('/configuration/languages', getApiKey(config), {}, 'GET', null, config), 
    24 * 60 * 60
  );
}

export async function primaryTranslations(config: UserConfig) {
  return cacheWrapGlobal('tmdb:primary_translations', () => 
    makeTmdbRequest('/configuration/primary_translations', getApiKey(config), {}, 'GET', null, config),
    24 * 60 * 60
  );
}

export async function movieInfo(params: any, config: UserConfig) {
  const { id, ...queryParams } = params;
  return makeTmdbRequest(`/movie/${id}`, getApiKey(config), queryParams, 'GET', null, config);
}
export async function tvInfo(params: any, config: UserConfig) {
  const { id, ...queryParams } = params;
  return makeTmdbRequest(`/tv/${id}`, getApiKey(config), queryParams, 'GET', null, config);
}

export async function movieExternalIds(id: string, config: UserConfig) {
  return cacheWrapGlobal(`tmdb:movie:external_ids:${id}`, () =>
    makeTmdbRequest(`/movie/${id}/external_ids`, getApiKey(config), {}, 'GET', null, config),
    24 * 60 * 60 // 24 hours
  );
}

export async function tvExternalIds(id: string, config: UserConfig) {
  return cacheWrapGlobal(`tmdb:tv:external_ids:${id}`, () => 
    makeTmdbRequest(`/tv/${id}/external_ids`, getApiKey(config), {}, 'GET', null, config),
    24 * 60 * 60 // 24 hours
  );
}

export async function movieCredits(params: any, config: UserConfig) {
  const { id, ...queryParams } = params;
  return makeTmdbRequest(`/movie/${id}/credits`, getApiKey(config), queryParams, 'GET', null, config);
}

export async function tvCredits(params: any, config: UserConfig) {
  const { id, ...queryParams } = params;
  return makeTmdbRequest(`/tv/${id}/credits`, getApiKey(config), queryParams, 'GET', null, config);
}

export async function searchMovie(params: any, config: UserConfig) {
  const startTime = Date.now();
  const query = params.query || 'unknown';
  consola.info(`[TMDB] Starting movie search for: "${query}"`);
  
  const result = await makeTmdbRequest('/search/movie', getApiKey(config), params, 'GET', null, config);
  
  const searchTime = Date.now() - startTime;
  const resultCount = result?.results?.length || 0;
  consola.info(`[TMDB] Movie search completed in ${searchTime}ms, found ${resultCount} results`);
  
  return result;
}

export async function searchTv(params: any, config: UserConfig) {
  const startTime = Date.now();
  const query = params.query || 'unknown';
  consola.info(`[TMDB] Starting TV search for: "${query}"`);
  
  const result = await makeTmdbRequest('/search/tv', getApiKey(config), params, 'GET', null, config);
  
  const searchTime = Date.now() - startTime;
  const resultCount = result?.results?.length || 0;
  consola.info(`[TMDB] TV search completed in ${searchTime}ms, found ${resultCount} results`);
  
  return result;
}

export async function searchPerson(params: any, config: UserConfig) {
  const startTime = Date.now();
  const query = params.query || 'unknown';
  consola.info(`[TMDB] Starting person search for: "${query}"`);
  
  const result = await makeTmdbRequest('/search/person', getApiKey(config), params, 'GET', null, config);
  
  const searchTime = Date.now() - startTime;
  const resultCount = result?.results?.length || 0;
  consola.info(`[TMDB] Person search completed in ${searchTime}ms, found ${resultCount} results`);
  
  return result;
}

export async function personInfo(params: any, config: UserConfig) {
  const startTime = Date.now();
  const personId = params.id || 'unknown';
  consola.info(`[TMDB] Fetching person info for ID: ${personId}`);
  
  const result = await makeTmdbRequest(`/person/${personId}`, getApiKey(config), params, 'GET', null, config);
  
  const fetchTime = Date.now() - startTime;
  consola.info(`[TMDB] Person info fetched in ${fetchTime}ms`);
  
  return result;
}

export async function personMovieCredits(params: any, config: UserConfig) {
  const startTime = Date.now();
  const personId = params.id || 'unknown';
  consola.info(`[TMDB] Fetching person movie credits for ID: ${personId}`);
  
  const result = await makeTmdbRequest(`/person/${personId}/movie_credits`, getApiKey(config), params, 'GET', null, config);
  
  const fetchTime = Date.now() - startTime;
  consola.info(`[TMDB] Person movie credits fetched in ${fetchTime}ms`);
  
  return result;
}

export async function personTvCredits(params: any, config: UserConfig) {
  const startTime = Date.now();
  const personId = params.id || 'unknown';
  consola.info(`[TMDB] Fetching person TV credits for ID: ${personId}`);
  
  const result = await makeTmdbRequest(`/person/${personId}/tv_credits`, getApiKey(config), params, 'GET', null, config);
  
  const fetchTime = Date.now() - startTime;
  consola.info(`[TMDB] Person TV credits fetched in ${fetchTime}ms`);
  
  return result;
}

export async function find(params: any, config: UserConfig) {
  return makeTmdbRequest(`/find/${params.id}`, getApiKey(config), { external_source: params.external_source }, 'GET', null, config);
}

export async function discoverMovie(params: any, config: UserConfig) {
  return makeTmdbRequest('/discover/movie', getApiKey(config), params, 'GET', null, config);
}

export async function discoverTv(params: any, config: UserConfig) {
  return makeTmdbRequest('/discover/tv', getApiKey(config), params, 'GET', null, config);
}

export async function genreMovieList(params: any, config: UserConfig) {
  const language = params.language || 'en';
  return cacheWrapGlobal(`tmdb:genre:movie:${language}`, () =>
    makeTmdbRequest('/genre/movie/list', getApiKey(config), params, 'GET', null, config),
    30 * 24 * 60 * 60,
    { skipVersion: true }
  );
}

export async function genreTvList(params: any, config: UserConfig) {
  const language = params.language || 'en';
  return cacheWrapGlobal(`tmdb:genre:tv:${language}`, () =>
    makeTmdbRequest('/genre/tv/list', getApiKey(config), params, 'GET', null, config),
    30 * 24 * 60 * 60,
    { skipVersion: true }
  );
}

export async function requestToken(config: UserConfig) { 
  return makeTmdbRequest('/authentication/token/new', getApiKey(config), {}, 'GET', null, config);
}

export async function sessionId(params: any, config: UserConfig) { 
  return makeTmdbRequest('/authentication/session/new', getApiKey(config), {}, 'POST', params, config);
}

export async function accountFavoriteMovies(params: any, config: UserConfig) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/favorite/movies`, apiKey, params, 'GET', null, config);
}

export async function accountFavoriteTv(params: any, config: UserConfig) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/favorite/tv`, apiKey, params, 'GET', null, config);
}

export async function accountMovieWatchlist(params: any, config: UserConfig) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/watchlist/movies`, apiKey, params, 'GET', null, config);
}

export async function accountTvWatchlist(params: any, config: UserConfig) {
  const apiKey = getApiKey(config);
  const account = await getAccountDetails(params.session_id, apiKey);
  return makeTmdbRequest(`/account/${account.id}/watchlist/tv`, apiKey, params, 'GET', null, config);
}

export async function getTmdbListDetails(params: any, config: UserConfig) {
  const apiKey = getApiKey(config);
  const listId = params.list_id;
  consola.info(`[TMDB] Fetching list details for list ID: ${listId}`);
  return makeTmdbRequest(`/list/${listId}`, apiKey, params, 'GET', null, config);
}

export async function getTmdbListItems(params: any, config: UserConfig) {
  const apiKey = getApiKey(config);
  const listId = params.list_id;
  consola.info(`[TMDB] Fetching list items for list ID: ${listId}, page: ${params.page || 1}`);
  
  const result = await makeTmdbRequest(`/list/${listId}`, apiKey, params, 'GET', null, config);
  
  return {
    items: result.items || [],
    page: result.page || 1,
    total_pages: result.total_pages || 1,
    total_results: result.total_results || 0,
    list_name: result.name || '',
    list_description: result.description || ''
  };
}

export async function getMovieCertifications(params: any, config: UserConfig) {
  const apiKey = getApiKey(config);
  return cacheWrapGlobal(`tmdb:movie:release_dates:${params.id}`, () =>
    makeTmdbRequest(`/movie/${params.id}/release_dates`, apiKey, params, 'GET', null, config),
    24 * 60 * 60 // 24 hours
  );
}

export async function getTvCertifications(params: any, config: UserConfig) {
  const apiKey = getApiKey(config);
  return cacheWrapGlobal(`tmdb:tv:content_ratings:${params.id}`, () =>
    makeTmdbRequest(`/tv/${params.id}/content_ratings`, apiKey, params, 'GET', null, config),
    24 * 60 * 60 
  );
}

export async function getMovieWatchProviders(params: any, config: UserConfig) {
  const data = await cacheWrapGlobal(`tmdb:movie:watch_providers:${params.id}`, () =>
    makeTmdbRequest(`/movie/${params.id}/watch/providers`, getApiKey(config), params, 'GET', null, config),
    24 * 60 * 60 
  );
  if (data?.results) {
    const country = config.language?.split('-')[1] || 'US';
    const countryProviders = data.results[country];
    
    if (countryProviders) {
      const providers: any[] = [];
      ['flatrate', 'buy', 'rent'].forEach(type => {
         if (countryProviders[type]) {
             countryProviders[type].forEach((provider: any) => {
                 providers.push({
                    name: provider.provider_name,
                    logo: provider.logo_path ? `https://image.tmdb.org/t/p/w500${provider.logo_path}` : null,
                    id: provider.provider_id,
                    type: type,
                    priority: provider.display_priority
                 });
             });
         }
      });
      providers.sort((a, b) => a.priority - b.priority);
      return { country, link: countryProviders.link, providers };
    }
  }
  return null;
}

export function getWatchProviders(data: any, config: UserConfig) {
  if (data?.results) {
    const country = config.language?.split('-')[1] || 'US';
    const countryProviders = data.results[country];
    
    if (countryProviders) {
      const providers: any[] = [];
      ['flatrate', 'buy', 'rent'].forEach(type => {
         if (countryProviders[type]) {
             countryProviders[type].forEach((provider: any) => {
                 providers.push({
                    name: provider.provider_name,
                    logo: provider.logo_path ? `https://image.tmdb.org/t/p/w500${provider.logo_path}` : null,
                    id: provider.provider_id,
                    type: type,
                    priority: provider.display_priority
                 });
             });
         }
      });
      providers.sort((a, b) => a.priority - b.priority);
      return { country, link: countryProviders.link, providers };
    }
  }
  return null;
}

export async function getTmdbImages(mediaType: string, tmdbId: string, config: UserConfig) {
  if (!tmdbId) return { posters: [], backdrops: [], logos: [] };
  try {
    const endpoint = `/${mediaType}/${tmdbId}/images`;
    // This makes ONE network request.
    return cacheWrapGlobal(`tmdb:${mediaType}:images:${tmdbId}`, () =>
      makeTmdbRequest(endpoint, getApiKey(config), {}, 'GET', null, config),
      24 * 60 * 60 
    ) || { posters: [], backdrops: [], logos: [] };
  } catch (error: any) {
    consola.warn(`[TMDB] Failed to get images for ${mediaType} ${tmdbId}:`, error.message);
    return { posters: [], backdrops: [], logos: [] };
  }
}

export async function getTvWatchProviders(params: any, config: UserConfig) {
  const data = await cacheWrapGlobal(`tmdb:tv:watch_providers:${params.id}`, () =>
    makeTmdbRequest(`/tv/${params.id}/watch/providers`, getApiKey(config), params, 'GET', null, config),
    24 * 60 * 60 
  );
  if (data?.results) {
    const country = config.language?.split('-')[1] || 'US';
    const countryProviders = data.results[country];
    if (countryProviders) {
        const providers: any[] = [];
        ['flatrate', 'buy', 'rent'].forEach(type => {
             if (countryProviders[type]) {
                 countryProviders[type].forEach((provider: any) => {
                     providers.push({
                        name: provider.provider_name,
                        logo: provider.logo_path ? `https://image.tmdb.org/t/p/w500${provider.logo_path}` : null,
                        id: provider.provider_id,
                        type: type,
                        priority: provider.display_priority
                     });
                 });
             }
        });
        providers.sort((a, b) => a.priority - b.priority);
        return { country, link: countryProviders.link, providers };
    }
  }
  return null;
}

export function getTranslations(translations: any, language: string) {
  if (translations?.translations) {
    const iso639 = language.split('-')[0];
    const iso3166 = language.split('-')[1];
    const translation = translations.translations.find((t: any) => t.iso_639_1 === iso639 && t.iso_3166_1 === iso3166);
    if (translation) {
      return translation;
    }
    return null;
  }
  return null;
}

export async function getTmdbMoviePoster(tmdbId: string, config: UserConfig) {
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
  } catch (error: any) {
    consola.warn(`[TMDB] Failed to get movie poster for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

export async function getTmdbSeriesPoster(tmdbId: string, config: UserConfig) {
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
  } catch (error: any) {
    consola.warn(`[TMDB] Failed to get series poster for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

export async function getTmdbMovieBackground(tmdbId: string, config: UserConfig) {
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
  } catch (error: any) {
    consola.warn(`[TMDB] Failed to get movie background for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

export async function getTmdbSeriesBackground(tmdbId: string, config: UserConfig) {
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
  } catch (error: any) {
    consola.warn(`[TMDB] Failed to get series background for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

export async function getTmdbMovieLogo(tmdbId: string, config: UserConfig) {
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
  } catch (error: any) {
    consola.warn(`[TMDB] Failed to get movie logo for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

export async function getTmdbSeriesLogo(tmdbId: string, config: UserConfig) {
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
  } catch (error: any) {
    consola.warn(`[TMDB] Failed to get series logo for TMDB ID ${tmdbId}:`, error.message);
    return null;
  }
}

export async function trending(params: any, config: UserConfig) {
    return makeTmdbRequest(`/trending/${params.media_type}/${params.time_window}`, getApiKey(config), params, 'GET', null, config);
}

export async function seasonInfo(params: any, config: UserConfig) {
  const { id, season_number, ...queryParams } = params;
  return cacheWrapGlobal(`tmdb:tv:season:${id}:${season_number}`, () =>
    makeTmdbRequest(`/tv/${id}/season/${season_number}`, getApiKey(config), queryParams, 'GET', null, config),
    24 * 60 * 60
  );
}

export async function movieImages(params: any, config: UserConfig) {
  const { id, ...queryParams } = params;
  const cacheKey = `tmdb:movie:images:${id}:${queryParams.include_image_language || 'all'}`;
  return cacheWrapGlobal(cacheKey, () =>
    makeTmdbRequest(`/movie/${id}/images`, getApiKey(config), queryParams, 'GET', null, config),
    24 * 60 * 60
  );
}

export async function tvImages(params: any, config: UserConfig) {
  const { id, ...queryParams } = params;
  const cacheKey = `tmdb:tv:images:${id}:${queryParams.include_image_language || 'all'}`;
  return cacheWrapGlobal(cacheKey, () =>
    makeTmdbRequest(`/tv/${id}/images`, getApiKey(config), queryParams, 'GET', null, config),
    24 * 60 * 60
  );
}

module.exports = {
  makeTmdbRequest, 
  movieInfo,
  tvInfo,
  searchMovie,
  searchTv,
  searchPerson,
  personInfo,
  personMovieCredits,
  personTvCredits,
  find,
  languages,
  primaryTranslations,
  discoverMovie,
  discoverTv,
  seasonInfo,
  trending,
  genreMovieList,
  genreTvList,
  requestToken,
  sessionId,
  getAccountDetails,
  accountFavoriteMovies,
  accountFavoriteTv,
  accountMovieWatchlist,
  accountTvWatchlist,
  getTmdbListDetails,
  getTmdbListItems,
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
  getWatchProviders,
  selectTmdbImageByLang,
  movieImages,
  tvImages
};