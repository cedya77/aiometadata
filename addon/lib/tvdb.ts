import { config } from 'dotenv';
config();
import { cacheWrapTvdbApi, stableStringify } from './getCache.js';
import { to3LetterCode } from './language-map.js';
import { httpPost, httpGet } from '../utils/httpClient.js';
import { UserConfig } from '../types/index.js';
import consola from 'consola';

const logger = consola.withTag('TVDB');

// TVDB-specific HTTP client with 429 rate limit handling
async function tvdbHttpRequest(url: string, options: any = {}, maxRetries: number = 3): Promise<any> {
  let lastError;
  const startTime = Date.now();
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (options.method === 'POST') {
        return await httpPost(url, options.data, options);
      } else {
        return await httpGet(url, options);
      }
    } catch (error: any) {
      lastError = error;
      const responseTime = Date.now() - startTime;
      
      // 404 is not a failure - the API worked, the content just doesn't exist
      // Return empty response instead of throwing
      if (error.response?.status === 404) {
        return { data: { data: null } };
      }
      
      // Check if it's a 429 rate limit error
      if (error.response?.status === 429) {
        // Log rate limit to dashboard
        const requestTracker = require('./requestTracker');
        requestTracker.logProviderError('tvdb', 'rate_limit', 'Rate limit exceeded (429)', {
          url: url.replace(/token=[^&]+/, 'token=***'), // Redact token
          responseTime,
          attempt: attempt + 1,
          maxRetries: maxRetries + 1
        });
        
        if (attempt < maxRetries) {
          // Calculate exponential backoff delay: 1s, 2s, 4s, 8s...
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // Cap at 30 seconds
          logger.warn(`Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        } else {
          logger.error(`Rate limited (429), max retries exceeded for ${url}`);
          throw error;
        }
      } else {
        // Log other errors on final attempt
        if (attempt >= maxRetries) {
          const requestTracker = require('./requestTracker');
          const status = error.response?.status;
          const errorType = status >= 500 ? 'server_error' : status === 401 || status === 403 ? 'auth_error' : 'api_error';
          requestTracker.logProviderError('tvdb', errorType, error.message || `Request failed with status ${status}`, {
            url: url.replace(/token=[^&]+/, 'token=***'),
            responseTime,
            status
          });
        }
        // Not a 429 error, throw immediately
        throw error;
      }
    }
  }
  
  throw lastError;
}

const TVDB_API_URL = 'https://api4.thetvdb.com/v4';
const GLOBAL_TVDB_KEY = process.env.TVDB_API_KEY || process.env.BUILT_IN_TVDB_API_KEY;
const TVDB_IMAGE_BASE = 'https://artworks.thetvdb.com/banners/images/';

// Type definitions for TVDB API responses
interface TvdbAuthResponse {
  data: {
    token: string;
  };
}

interface TvdbSearchResult {
  tvdb_id: string;
  name: string;
  year?: string;
  type: string;
  image_url?: string;
  overview?: string;
  first_air_time?: string;
  network?: string;
  country?: string;
  status?: string;
  slug?: string;
}

interface TvdbSeriesExtended {
  id: string;
  name: string;
  slug: string;
  image: string;
  overview: string;
  firstAired: string;
  lastAired: string;
  year: string;
  status: {
    id: number;
    name: string;
    recordType: string;
    keepUpdated: boolean;
  };
  runtime: number;
  averageRuntime: number;
  originalCountry: string;
  originalLanguage: string;
  defaultSeasonType: number;
  isOrderRandomized: boolean;
  lastUpdated: string;
  nameTranslations: string[];
  overviewTranslations: string[];
  airsTime: string;
  airsDayOfWeek: string;
  genres: Array<{
    id: number;
    name: string;
    slug: string;
  }>;
  tags: Array<{
    id: number;
    name: string;
    slug: string;
    tagName: string;
  }>;
  characters: Array<{
    id: number;
    name: string;
    peopleId: number;
    peopleType: string;
    personName: string;
    personImgURL?: string;
    image?: string;
  }>;
  companies: {
    production: Array<{
      id: number;
      name: string;
      slug: string;
      description?: string;
    }>;
    network: Array<{
      id: number;
      name: string;
      slug: string;
      description?: string;
    }>;
    studio: Array<{
      id: number;
      name: string;
      slug: string;
      description?: string;
    }>;
  };
  remoteIds: Array<{
    id: string;
    sourceName: string;
    sourceId: string;
    url?: string;
  }>;
  seasons: Array<{
    id: number;
    name: string;
    slug: string;
    number: number;
    image?: string;
    year?: string;
    type: {
      id: number;
      name: string;
      type: string;
      alternateName?: string;
    };
  }>;
  artworks: Array<{
    id: number;
    image: string;
    type: number;
    width: number;
    height: number;
    thumbnail: string;
    updatedAt: string;
  }>;
  trailers: Array<{
    id: string;
    name: string;
    url: string;
    language: string;
    runtime: number;
    thumbnail?: string;
  }>;
  translations: {
    nameTranslations: Array<{
      language: string;
      name: string;
    }>;
    overviewTranslations: Array<{
      language: string;
      overview: string;
    }>;
  };
}

interface TvdbMovieExtended {
  id: string;
  name: string;
  slug: string;
  image: string;
  overview: string;
  runtime: number;
  year: string;
  originalCountry: string;
  originalLanguage: string;
  first_release: {
    Date: string;
  };
  genres: Array<{
    id: number;
    name: string;
    slug: string;
  }>;
  characters: Array<{
    id: number;
    name: string;
    peopleId: number;
    peopleType: string;
    personName: string;
    personImgURL?: string;
    image?: string;
  }>;
  companies: {
    production: Array<{
      id: number;
      name: string;
      slug: string;
      description?: string;
    }>;
    network: Array<{
      id: number;
      name: string;
      slug: string;
      description?: string;
    }>;
    studio: Array<{
      id: number;
      name: string;
      slug: string;
      description?: string;
    }>;
  };
  remoteIds: Array<{
    id: string;
    sourceName: string;
    sourceId: string;
    url?: string;
  }>;
  artworks: Array<{
    id: number;
    image: string;
    type: number;
    width: number;
    height: number;
    score: number;
    includesText: boolean;
    thumbnail: string;
    updatedAt: string;
  }>;
  trailers: Array<{
    id: string;
    name: string;
    url: string;
    language: string;
    runtime: number;
    thumbnail?: string;
  }>;
  translations: {
    nameTranslations: Array<{
      language: string;
      name: string;
    }>;
    overviewTranslations: Array<{
      language: string;
      overview: string;
    }>;
  };
}

interface TvdbEpisode {
  id: number;
  name: string;
  slug: string;
  number: number;
  seasonNumber: number;
  absoluteNumber: number;
  overview: string;
  image: string;
  aired: string;
  runtime: number;
  lastUpdated: string;
  translations: {
    nameTranslations: Array<{
      language: string;
      name: string;
    }>;
    overviewTranslations: Array<{
      language: string;
      overview: string;
    }>;
  };
}

interface TvdbEpisodesResponse {
  episodes: TvdbEpisode[];
  pageInfo: {
    page: number;
    pageSize: number;
    totalRecords: number;
    totalPages: number;
  };
}

interface TvdbPersonExtended {
  id: string;
  name: string;
  slug: string;
  image: string;
  overview: string;
  birthDate: string;
  deathDate?: string;
  birthPlace: string;
  deathPlace?: string;
  gender: number;
  remoteIds: Array<{
    id: string;
    sourceName: string;
    sourceId: string;
    url?: string;
  }>;
  translations: {
    nameTranslations: Array<{
      language: string;
      name: string;
    }>;
    overviewTranslations: Array<{
      language: string;
      overview: string;
    }>;
  };
}

interface TvdbGenre {
  id: number;
  name: string;
  slug: string;
}

interface TvdbLanguageRecord {
  id?: string;
  name?: string;
  nativeName?: string;
  shortCode?: string;
}

interface TvdbCountryRecord {
  id?: string;
  name?: string;
  shortCode?: string;
}

interface TvdbContentRatingRecord {
  id?: number;
  name?: string;
  fullName?: string;
  country?: string;
  contentType?: string;
  order?: number;
}

interface TvdbCompanyTypeRecord {
  companyTypeId?: number;
  companyTypeName?: string;
}

interface TvdbStatusRecord {
  id?: number | null;
  name?: string;
  recordType?: string;
  keepUpdated?: boolean;
}

interface TvdbFilterResult {
  id: string;
  name: string;
  slug: string;
  image: string;
  overview: string;
  year: string;
  score: number;
  type: string;
  firstAired?: string;
  lastAired?: string;
  status?: string;
  network?: string;
  country?: string;
  runtime?: number;
  genres?: Array<{
    id: number;
    name: string;
  }>;
}

interface TvdbSeasonExtended {
  id: number;
  name: string;
  slug: string;
  number: number;
  image?: string;
  year?: string;
  type: {
    id: number;
    name: string;
    type: string;
    alternateName?: string;
  };
  episodes: TvdbEpisode[];
}

interface TvdbCollection {
  id: string;
  name: string;
  slug: string;
  image?: string;
  overview?: string;
  year?: string;
  entityCount: number;
  entities: Array<{
    seriesId?: string;
    movieId?: string;
    order: number;
  }>;
}

interface TvdbCollectionTranslation {
  name: string;
  overview: string;
  language: string;
}

interface TokenCache {
  token: string;
  expiry: number;
}

// Global caches
const tokenCache = new Map<string, TokenCache>(); // Global cache for self-hosted instances
const userTokenCaches = new Map<string, Map<string, TokenCache>>(); // Per-user cache for public instances

async function getAuthToken(apiKey: string | undefined, userUUID: string | null = null): Promise<string | null> {
  const key = apiKey || GLOBAL_TVDB_KEY;
  if (!key) {
    logger.error('TVDB API Key is not configured.');
    return null;
  }

  // For public instances (with userUUID), use per-user cache
  if (userUUID) {
    if (!userTokenCaches.has(userUUID)) {
      userTokenCaches.set(userUUID, new Map());
    }
    
    const userCache = userTokenCaches.get(userUUID)!;
    const cached = userCache.get(key);
    if (cached && Date.now() < cached.expiry) {
      return cached.token;
    }

    try {
      const response = await tvdbHttpRequest(`${TVDB_API_URL}/login`, { method: 'POST', data: { apikey: key } });
      const token = response.data.data?.token;
      if (!token) {
        logger.error(`No token in login response for user ${userUUID}`);
        return null;
      }
      const expiry = Date.now() + (28 * 24 * 60 * 60 * 1000);
      
      userCache.set(key, { token, expiry });
      return token;
    } catch (error) {
      logger.error(`Failed to get TVDB auth token for user ${userUUID} with key ...${key.slice(-4)}:`, (error as Error).message);
      return null;
    }
  }

  // For self-hosted instances (no userUUID), use global cache
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiry) {
    return cached.token;
  }

  try {
    const response = await tvdbHttpRequest(`${TVDB_API_URL}/login`, { method: 'POST', data: { apikey: key } });
    const token = response.data.data?.token;
    if (!token) {
      logger.error(`No token in global login response`);
      return null;
    }
    const expiry = Date.now() + (28 * 24 * 60 * 60 * 1000);
    
    tokenCache.set(key, { token, expiry });
    return token;
  } catch (error) {
    logger.error(`Failed to get TVDB auth token for key ...${key.slice(-4)}:`, (error as Error).message);
    return null;
  }
}

function _filterTvdbSearchResults(results: TvdbSearchResult[], query: string): TvdbSearchResult[] {
  if (!results || results.length === 0) {
    return [];
  }

  const filteredResults = results.filter((item: TvdbSearchResult) => {
    // Rule 1: Filter out items with "YouTube" as the network.
    if (item.network === 'YouTube') {
      return false;
    }

    // Rule 2: Filter out items that have no network AND a missing/placeholder poster.
    const hasMissingPoster = !item.image_url || item.image_url.includes('/images/missing/');
    if (!item.network && hasMissingPoster) {
      return false;
    }
    
    return true;
  });

  return filteredResults;
}

async function searchSeries(query: string, config: UserConfig): Promise<TvdbSearchResult[]> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  
  const startTime = Date.now();
  try {
    const response = await tvdbHttpRequest(`${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=series`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const results = (response.data as any)?.data || [];
    return _filterTvdbSearchResults(results, query);
    
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    logger.error(`[searchSeries] Error searching TVDB for series "${query}":`, (error as Error).message);
    return [];
  }
}

async function searchMovies(query: string, config: UserConfig): Promise<TvdbSearchResult[]> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  
  const startTime = Date.now();
  try {
    const response = await tvdbHttpRequest(`${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=movie`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const results = (response.data as any)?.data || [];
    return _filterTvdbSearchResults(results, query);

  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    logger.error(`[searchMovies] Error searching TVDB for movies "${query}":`, (error as Error).message);
    return [];
  }
}

async function searchPeople(query: string, config: UserConfig): Promise<TvdbSearchResult[]> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  
  const startTime = Date.now();
  try {
    const response = await tvdbHttpRequest(`${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=people`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    return (response.data as any)?.data || [];
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    logger.error(`[searchPeople] Error searching TVDB for people "${query}":`, (error as Error).message);
    return [];
  }
}

async function searchCompanies(query: string, config: UserConfig): Promise<any[]> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];

  const startTime = Date.now();
  try {
    const response = await tvdbHttpRequest(
      `${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=company&limit=25`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
      }
    );

    const responseTime = Date.now() - startTime;

    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);

    return (response.data as any)?.data || [];
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);

    logger.error(`[searchCompanies] Error searching TVDB for companies "${query}":`, (error as Error).message);
    return [];
  }
}

async function searchCollections(query: string, config: UserConfig): Promise<TvdbSearchResult[]> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  
  const startTime = Date.now();
  try {
    const response = await tvdbHttpRequest(`${TVDB_API_URL}/search?query=${encodeURIComponent(query)}&type=list`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    return (response.data as any)?.data || [];
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    logger.error(`[searchCollections] Error searching TVDB for collections "${query}":`, (error as Error).message);
    return [];
  }
}

async function getSeriesExtended(seriesId: string, config: UserConfig): Promise<TvdbSeriesExtended | null> {
  return cacheWrapTvdbApi(`series-extended:${seriesId}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return null;

    const url = `${TVDB_API_URL}/series/${seriesId}/extended?meta=translations`;
    const startTime = Date.now();
    
    try {
      const response = await tvdbHttpRequest(url, { headers: { 'Authorization': `Bearer ${token}` } });
      const responseTime = Date.now() - startTime;
      
      // Track successful request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);
      
      return (response.data as any)?.data;
    } catch(error) {
      // Track failed request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      
      logger.error(`[getSeriesExtended] Error fetching extended series data for TVDB ID ${seriesId}:`, (error as Error).message);
      return null; 
    }
  });
}

async function getMovieExtended(movieId: string, config: UserConfig): Promise<TvdbMovieExtended | null> {
  return cacheWrapTvdbApi(`movie-extended:${movieId}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return null;

    const url = `${TVDB_API_URL}/movies/${movieId}/extended?meta=translations`;
    const startTime = Date.now();
    
    try {
      const response = await tvdbHttpRequest(url, { headers: { 'Authorization': `Bearer ${token}` } });
      const responseTime = Date.now() - startTime;
      
      // Track successful request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);
      
      return (response.data as any)?.data;
    } catch(error) {
      // Track failed request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      
      logger.error(`[getMovieExtended] Error fetching extended movie data for TVDB ID ${movieId}:`, (error as Error).message);
      return null; 
    }
  });
}

async function getPersonExtended(personId: string, config: UserConfig): Promise<TvdbPersonExtended | null> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return null;
  
  const startTime = Date.now();
  try {
    const response = await tvdbHttpRequest(`${TVDB_API_URL}/people/${personId}/extended`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    return (response.data as any)?.data;
  } catch (error) {
    logger.error(`Error getting person extended for ID ${personId}:`, (error as Error).message);
    return null;
  }
}

async function _fetchEpisodesBySeasonType(tvdbId: string, seasonType: string, language: string, config: UserConfig): Promise<{ episodes: TvdbEpisode[] } | null> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return null;

  const langCode3 = await to3LetterCode(language.split('-')[0], config);
  
  let allEpisodes: TvdbEpisode[] = [];
  let page = 0;
  let hasNextPage = true;

  while(hasNextPage) {
    const url = `${TVDB_API_URL}/series/${tvdbId}/episodes/${seasonType}/${langCode3}?page=${page}`;
    try {
      const response = await tvdbHttpRequest(url, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = response.data as any;
      if (data.data && data.data.episodes) {
        allEpisodes.push(...data.data.episodes);
      }
      hasNextPage = data.links && data.links.next;
      page++;
    } catch(error) {
      logger.error(`[_fetchEpisodesBySeasonType] Error fetching page ${page} of ${seasonType} episodes for TVDB ID ${tvdbId}:`, (error as Error).message);
      hasNextPage = false;
    }
  }
  return { episodes: allEpisodes };
}

async function getSeriesEpisodes(tvdbId: string, language: string = 'en-US', seasonType: string = 'default', config: UserConfig = {} as UserConfig, bypassCache: boolean = false): Promise<TvdbEpisodesResponse | null> {
  const cacheKey = `series-episodes:${tvdbId}:${language}:${seasonType}`;

  return cacheWrapTvdbApi(cacheKey, async () => {
    const consola = require('consola');
    consola.debug(`[TVDB] Fetching episodes for ${tvdbId} with type: '${seasonType}' and lang: '${language}'`);
    let result = await _fetchEpisodesBySeasonType(tvdbId, seasonType, language, config);
 
    if ((!result || result.episodes.length === 0) && seasonType !== 'official') {
      logger.debug(`No episodes found for type '${seasonType}'. Falling back to 'official' order.`);
      result = await _fetchEpisodesBySeasonType(tvdbId, 'official', language, config);
    }

    if ((!result || result.episodes.length === 0) && language !== 'en-US') {
      logger.debug(`No episodes found in '${language}'. Falling back to 'en-US'.`);
      return getSeriesEpisodes(tvdbId, 'en-US', seasonType, config, true); 
    }
    
    return result;
  });
}

async function findByImdbId(imdbId: string, config: UserConfig): Promise<TvdbSearchResult[]> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  
  const startTime = Date.now();
  try {
    const response = await tvdbHttpRequest(`${TVDB_API_URL}/search/remoteid/${imdbId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const results = (response.data as any)?.data || [];
    const consola = require('consola');
    consola.debug(`[TVDB] Found TVDB ID for IMDB ID ${imdbId}:`, results);
    return results;
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    logger.error(`[findByImdbId] Error finding TVDB by IMDb ID ${imdbId}:`, (error as Error).message);
    return [];
  }
}

async function findByTmdbId(tmdbId: string, config: UserConfig): Promise<TvdbSearchResult[]> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  
  const startTime = Date.now();
  try {
    const response = await tvdbHttpRequest(`${TVDB_API_URL}/search/remoteid/${tmdbId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const results = (response.data as any)?.data || [];
    
    return results;
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    logger.error(`[findByTmdbId] Error finding TVDB by TMDB ID ${tmdbId}:`, (error as Error).message);
    return [];
  }
}

async function getAllGenres(config: UserConfig): Promise<TvdbGenre[]> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  
  const startTime = Date.now();
  try {
    const response = await tvdbHttpRequest(`${TVDB_API_URL}/genres`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    const results = (response.data as any)?.data || [];
    
    return results;
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    logger.error(`[getAllGenres] Error getting TVDB genres:`, (error as Error).message);
    return [];
  }
}

async function getAllLanguages(config: UserConfig): Promise<TvdbLanguageRecord[]> {
  return cacheWrapTvdbApi(`tvdb-languages`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return [];

    const startTime = Date.now();
    try {
      const response = await tvdbHttpRequest(`${TVDB_API_URL}/languages`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);

      return (response.data as any)?.data || [];
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);

      logger.error(`[getAllLanguages] Error getting TVDB languages:`, (error as Error).message);
      return [];
    }
  });
}

async function getAllCountries(config: UserConfig): Promise<TvdbCountryRecord[]> {
  return cacheWrapTvdbApi(`tvdb-countries`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return [];

    const startTime = Date.now();
    try {
      const response = await tvdbHttpRequest(`${TVDB_API_URL}/countries`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);

      return (response.data as any)?.data || [];
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);

      logger.error(`[getAllCountries] Error getting TVDB countries:`, (error as Error).message);
      return [];
    }
  });
}

async function getAllContentRatings(config: UserConfig): Promise<TvdbContentRatingRecord[]> {
  return cacheWrapTvdbApi(`tvdb-content-ratings`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return [];

    const startTime = Date.now();
    try {
      const response = await tvdbHttpRequest(`${TVDB_API_URL}/content/ratings`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);

      return (response.data as any)?.data || [];
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);

      logger.error(`[getAllContentRatings] Error getting TVDB content ratings:`, (error as Error).message);
      return [];
    }
  });
}

async function getCompanyTypes(config: UserConfig): Promise<TvdbCompanyTypeRecord[]> {
  return cacheWrapTvdbApi(`tvdb-company-types`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return [];

    const startTime = Date.now();
    try {
      const response = await tvdbHttpRequest(`${TVDB_API_URL}/companies/types`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);

      return (response.data as any)?.data || [];
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);

      logger.error(`[getCompanyTypes] Error getting TVDB company types:`, (error as Error).message);
      return [];
    }
  });
}

async function getStatuses(type: 'movies' | 'series', config: UserConfig): Promise<TvdbStatusRecord[]> {
  const cacheKey = `tvdb-statuses:${type}`
  return cacheWrapTvdbApi(cacheKey, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return [];

    const startTime = Date.now();
    try {
      const endpoint = type === 'movies' ? '/movies/statuses' : '/series/statuses';
      const response = await tvdbHttpRequest(`${TVDB_API_URL}${endpoint}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);

      return (response.data as any)?.data || [];
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);

      logger.error(`[getStatuses] Error getting TVDB ${type} statuses:`, (error as Error).message);
      return [];
    }
  });
}

async function filter(type: 'movies' | 'series', params: any, config: UserConfig): Promise<TvdbFilterResult[]> {
  return cacheWrapTvdbApi(`tvdb-filter:${type}:${stableStringify(params)}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return [];
    
    const startTime = Date.now();
    try {
      const queryParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          queryParams.append(key, String(value));
        }
      });
      
      const response = await tvdbHttpRequest(`${TVDB_API_URL}/${type}/filter?${queryParams.toString()}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      
      const responseTime = Date.now() - startTime;
      
      // Track successful request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);
      
      const results = (response.data as any)?.data || [];
      
      return results;
    } catch (error) {
      // Track failed request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      
      logger.error(`[filter] Error filtering TVDB ${type}:`, (error as Error).message);
      return [];
    }
  });
}

async function getSeasonExtended(seasonId: string, config: UserConfig): Promise<TvdbSeasonExtended | null> {
  return cacheWrapTvdbApi(`season-extended:${seasonId}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return null;

    const url = `${TVDB_API_URL}/seasons/${seasonId}/extended`;
    const startTime = Date.now();
    
    try {
      const response = await tvdbHttpRequest(url, { 
        headers: { 'Authorization': `Bearer ${token}` } 
      });
      
      const responseTime = Date.now() - startTime;
      
      // Track successful request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, true);
      
      return (response.data as any)?.data;
    } catch(error) {
      // Track failed request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('tvdb', responseTime, false);
      
      logger.error(`[getSeasonExtended] Error fetching extended season data for TVDB ID ${seasonId}:`, (error as Error).message);
      return null; 
    }
  });
}

const findArtwork = (artworks, type, lang, config) => {
  if (lang === null) {
    return artworks?.find(a => a.type === type && a.language === null)?.image
      || artworks?.find(a => a.type === type)?.image;
  }
  // If englishArtOnly is enabled, prefer English artwork first
  if (config?.artProviders?.englishArtOnly) {
    return artworks?.find(a => a.type === type && a.language === 'eng')?.image
      || artworks?.find(a => a.type === type)?.image;
  }
  // Otherwise use preferred language fallback
  return artworks?.find(a => a.type === type && a.language === lang)?.image
    || artworks?.find(a => a.type === type && a.language === 'eng')?.image
    || artworks?.find(a => a.type === type)?.image;
};

async function getSeriesPoster(seriesId: string, config: UserConfig): Promise<string | null> {
  try {
    const seriesData = await getSeriesExtended(seriesId, config);
    const langCode = config.language?.split('-')[0];
    let langCode3 = 'eng';
    if (langCode) {
       langCode3 = await to3LetterCode(langCode, config);
    }
    if (seriesData && seriesData.artworks) {
      const posterArtwork = findArtwork(seriesData.artworks, 2, langCode3, config);
      return posterArtwork;
    }
    return null;
  } catch (error) {
    logger.error(`[getSeriesPoster] Error getting poster for series ${seriesId}:`, (error as Error).message);
    return null;
  }
}


async function getSeriesBackground(seriesId: string, config: UserConfig, isLandscape = false): Promise<string | null> {
  try {
    const seriesData = await getSeriesExtended(seriesId, config);
    if (seriesData && seriesData.artworks) {
      // Look for background artwork (type 3 is typically background)
      let langCode3;
      if (isLandscape) {
        const langCode = config.language?.split('-')[0];
        if (langCode) {
          langCode3 = await to3LetterCode(langCode, config);
        }
      }
      const backgroundArtwork = findArtwork(seriesData.artworks, 3, langCode3, config);
      logger.debug(`Found background artwork for series ${seriesId}: ${backgroundArtwork}`);
      return backgroundArtwork;
    }
    return null;
  } catch (error) {
    logger.error(`[getSeriesBackground] Error getting background for series ${seriesId}:`, (error as Error).message);
    return null;
  }
}

async function getMoviePoster(movieId: string, config: UserConfig): Promise<string | null> {
  try {
    const movieData = await getMovieExtended(movieId, config);
    const langCode = config.language?.split('-')[0];
    let langCode3 = 'eng';
    if (langCode) {
       langCode3 = await to3LetterCode(langCode, config);
    }
    if (movieData && movieData.artworks) {
      const posterArtwork = findArtwork(movieData.artworks, 14, langCode3, config);
      return posterArtwork;
    }
    return null;
  } catch (error) {
    logger.error(`[getMoviePoster] Error getting poster for movie ${movieId}:`, (error as Error).message);
    return null;
  }
}

async function getMovieBackground(movieId: string, config: UserConfig, isLandscape = false): Promise<string | null> {
  try {
    const movieData = await getMovieExtended(movieId, config);
    if (movieData && movieData.artworks) {
      let langCode3;
      if (isLandscape) {
        const langCode = config.language?.split('-')[0];
        if (langCode) {
          langCode3 = await to3LetterCode(langCode, config);
        }
      }
      // Look for background artwork (type 15 is background for movies)
      const backgroundArtwork = findArtwork(movieData.artworks, 15, langCode3, config);
      if (backgroundArtwork) {
        return backgroundArtwork;
      }
      
      // Fallback to type 3 if type 15 not found
      const fallbackBackground = findArtwork(movieData.artworks, 3, null, config);
      if (fallbackBackground) {
        return fallbackBackground;
      }
    }
    return null;
  } catch (error) {
    logger.error(`[getMovieBackground] Error getting background for movie ${movieId}:`, (error as Error).message);
    return null;
  }
}

async function getSeriesLogo(seriesId: string, config: UserConfig): Promise<string | null> {
  try {
    const seriesData = await getSeriesExtended(seriesId, config);
    const langCode = config.language?.split('-')[0];
    let langCode3 = 'eng';
    if (langCode) {
       langCode3 = await to3LetterCode(langCode, config);
    }
    if (seriesData && seriesData.artworks) {
      // Look for clear logo artwork (type 23 is clear logo for series)
      const logoArtwork = findArtwork(seriesData.artworks, 23, langCode3, config);
      if (logoArtwork) {
        return logoArtwork;
      }
    }
    return null;
  } catch (error) {
    logger.error(`[getSeriesLogo] Error getting logo for series ${seriesId}:`, (error as Error).message);
    return null;
  }
}

async function getMovieLogo(movieId: string, config: UserConfig): Promise<string | null> {
  try {
    const movieData = await getMovieExtended(movieId, config);
    const langCode = config.language?.split('-')[0];
    let langCode3 = 'eng';
    if (langCode) {
       langCode3 = await to3LetterCode(langCode, config);
    }
    if (movieData && movieData.artworks) {
      // Look for clear logo artwork (type 25 is clear logo for movies)
      const logoArtwork = findArtwork(movieData.artworks, 25, langCode3, config);
      if (logoArtwork) {
        return logoArtwork;
      }
    }
    return null;
  } catch (error) {
    logger.error(`[getMovieLogo] Error getting logo for movie ${movieId}:`, (error as Error).message);
    return null;
  }
}

async function getCollectionsList(config: UserConfig, page: number = 0): Promise<TvdbCollection[]> {
  const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
  if (!token) return [];
  logger.debug(`Getting collections list for page ${page}`);
  const startTime = Date.now();
  try {
    const response = await tvdbHttpRequest(`${TVDB_API_URL}/lists?page=${page}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    const responseTime = Date.now() - startTime;
    
    const results = (response.data as any)?.data || [];
    logger.debug(`Found ${results.length} collections for page ${page}`);
    // Track successful request
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, true);
    
    return results;
  } catch (error) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('tvdb', responseTime, false);
    
    logger.error(`[getCollections] Error getting TVDB collections list:`, (error as Error).message);
    return [];
  }
}

async function getCollectionDetails(collectionId: string, config: UserConfig): Promise<TvdbCollection | null> {
  return cacheWrapTvdbApi(`collection-details:${collectionId}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return null;
    try {
      const url = `${TVDB_API_URL}/lists/${collectionId}/extended`;
      const response = await tvdbHttpRequest(url, { headers: { 'Authorization': `Bearer ${token}` } });
      return (response.data as any)?.data;
    } catch (error) {
      logger.error(`Error fetching collection details for ID ${collectionId}:`, (error as Error).message);
      return null;
    }
  });
}

async function getCollectionTranslations(collectionId: string, language: string, config: UserConfig): Promise<TvdbCollectionTranslation | null> {
  return cacheWrapTvdbApi(`collection-translations:${collectionId}:${language}`, async () => {
    const token = await getAuthToken(config.apiKeys?.tvdb, config.userUUID);
    if (!token) return null;
    try {
      const url = `${TVDB_API_URL}/lists/${collectionId}/translations/${language}`;
      const response = await tvdbHttpRequest(url, { headers: { 'Authorization': `Bearer ${token}` } });
      const data = (response.data as any)?.data;
      
      // If no data found and language is not English, fallback to English
      if ((!data || !data.name) && language !== 'eng') {
        logger.debug(`No translations found for collection ${collectionId} in ${language}, falling back to English`);
        const engUrl = `${TVDB_API_URL}/lists/${collectionId}/translations/eng`;
        const engResponse = await tvdbHttpRequest(engUrl, { headers: { 'Authorization': `Bearer ${token}` } });
        return (engResponse.data as any)?.data;
      }
      
      return data;
    } catch (error) {
      logger.error(`Error fetching collection translations for ID ${collectionId}:`, (error as Error).message);
      return null;
    }
  });
}

export {
  searchSeries,
  searchMovies,
  searchPeople,
  searchCompanies,
  searchCollections,
  getSeriesExtended,
  getMovieExtended,
  getPersonExtended,
  getSeriesEpisodes,
  findByImdbId,
  findByTmdbId,
  getAllGenres,
  getAllLanguages,
  getAllCountries,
  getAllContentRatings,
  getCompanyTypes,
  getStatuses,
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

// CommonJS compatibility
module.exports = {
  searchSeries,
  searchMovies,
  searchPeople,
  searchCompanies,
  searchCollections,
  getSeriesExtended,
  getMovieExtended,
  getPersonExtended,
  getSeriesEpisodes,
  findByImdbId,
  findByTmdbId,
  getAllGenres,
  getAllLanguages,
  getAllCountries,
  getAllContentRatings,
  getCompanyTypes,
  getStatuses,
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
