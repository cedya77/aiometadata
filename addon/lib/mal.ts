require("dotenv").config();
const { httpGet }: any = require('../utils/httpClient');
const { socksDispatcher }: any = require('fetch-socks');
const { Agent, ProxyAgent }: any = require('undici');
const consola: any = require('consola');
const redis: any = require('./redisClient');
const logger: any = consola.withTag('MAL');
const {
  normalizeJikanAnimeDetailsForCache,
  normalizeJikanAnimeCharactersForCache,
  normalizeJikanAnimeEpisodesForCache,
  normalizeJikanCatalogForCache,
}: any = require('./jikanCacheNormalizers');

const JIKAN_API_BASE = process.env.JIKAN_API_BASE || 'https://api.jikan.moe/v4';

interface EtagEntry {
  etag: string;
  data: any;
  timestamp: number;
}

interface RequestTask {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  task: () => Promise<any>;
  url: string;
  retries: number;
}

const etagCache = new Map<string, EtagEntry>();

setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const [url, entry] of etagCache.entries()) {
    if (now - entry.timestamp > maxAge) {
      etagCache.delete(url);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.debug(`Cleaned ${cleaned} expired ETag entries. Cache size: ${etagCache.size}`);
  }
}, 60 * 60 * 1000);

const MAL_SOCKS_PROXY_URL = process.env.MAL_SOCKS_PROXY_URL;
const HTTP_PROXY_URL = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
let malDispatcher: any;

if (MAL_SOCKS_PROXY_URL) {
  try {
    const proxyUrlObj = new URL(MAL_SOCKS_PROXY_URL);
    if (proxyUrlObj.protocol === 'socks5:' || proxyUrlObj.protocol === 'socks4:') {
      malDispatcher = socksDispatcher({
        type: proxyUrlObj.protocol === 'socks5:' ? 5 : 4,
        host: proxyUrlObj.hostname,
        port: parseInt(proxyUrlObj.port),
        userId: proxyUrlObj.username,
        password: proxyUrlObj.password,
      });
      logger.info(`SOCKS proxy is enabled for Jikan API via fetch-socks.`);
    } else {
      logger.warn(`Unsupported proxy protocol: ${proxyUrlObj.protocol}. Falling back.`);
      malDispatcher = null;
    }
  } catch (error: any) {
    logger.warn(`Invalid MAL_SOCKS_PROXY_URL. Falling back. Error: ${error.message}`);
    malDispatcher = null;
  }
}

if (!malDispatcher) {
  if (HTTP_PROXY_URL) {
    try {
      malDispatcher = new ProxyAgent({ uri: new URL(HTTP_PROXY_URL).toString(), allowH2: false });
      logger.info('Using global HTTP proxy for Jikan API.');
    } catch (error: any) {
      logger.warn(`Invalid HTTP_PROXY URL. Using direct connection. Error: ${error.message}`);
      malDispatcher = new Agent({ allowH2: false, connect: { timeout: 30000 } });
    }
  } else {
    malDispatcher = new Agent({ allowH2: false, connect: { timeout: 30000 } });
    logger.info('undici agent is enabled for direct connections.');
  }
}

const MAX_CONCURRENT = parseInt(String(process.env.JIKAN_MAX_CONCURRENT), 10) || 2;
const MIN_REQUEST_INTERVAL = parseInt(String(process.env.JIKAN_MIN_INTERVAL), 10) || 350;
const MAX_REQUESTS_PER_MINUTE = parseInt(String(process.env.JIKAN_MAX_PER_MINUTE), 10) || 55;
const MAX_RETRIES = 3;
const RATE_LIMIT_DELAY = 2000;

let requestQueue: RequestTask[] = [];
let activeRequests = 0;
let isProcessing = false;
let rateLimitHitTimestamps: number[] = [];
let requestTimestamps: number[] = [];
let lastDispatchTime = 0;
let adaptiveConcurrency = MAX_CONCURRENT;
let lastAdaptiveRestore = Date.now();

function onRateLimitHit(): void {
  const now = Date.now();
  rateLimitHitTimestamps.push(now);
  rateLimitHitTimestamps = rateLimitHitTimestamps.filter(t => now - t < 60000);

  adaptiveConcurrency = 1;
  lastAdaptiveRestore = now;

  logger.warn(`[Rate Limiter] Concurrency reduced to 1 (${rateLimitHitTimestamps.length} hits in last 60s)`);
}

function maybeRestoreConcurrency(): void {
  const now = Date.now();
  const recentHits = rateLimitHitTimestamps.filter(t => now - t < 60000).length;

  if (recentHits === 0 && now - lastAdaptiveRestore > 30000 && adaptiveConcurrency < MAX_CONCURRENT) {
    adaptiveConcurrency = Math.min(adaptiveConcurrency + 1, MAX_CONCURRENT);
    lastAdaptiveRestore = now;
    logger.debug(`[Rate Limiter] Concurrency restored to ${adaptiveConcurrency}/${MAX_CONCURRENT}`);
  }
}

function getMinuteWaitTime(): number {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < 60000);

  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    const oldestInWindow = requestTimestamps[0];
    const waitMs = 60000 - (now - oldestInWindow) + 150;
    return Math.max(0, waitMs);
  }
  return 0;
}

async function processQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    if (activeRequests >= adaptiveConcurrency) {
      await new Promise(resolve => setTimeout(resolve, 50));
      continue;
    }

    const minuteWait = getMinuteWaitTime();
    if (minuteWait > 0) {
      logger.debug(`[Rate Limiter] Per-minute limit approaching (${requestTimestamps.length}/${MAX_REQUESTS_PER_MINUTE}), waiting ${minuteWait}ms`);
      await new Promise(resolve => setTimeout(resolve, minuteWait));
      continue;
    }

    const now = Date.now();
    const timeSinceLast = now - lastDispatchTime;
    const perSecondWait = Math.max(0, MIN_REQUEST_INTERVAL - timeSinceLast);
    if (perSecondWait > 0) {
      await new Promise(resolve => setTimeout(resolve, perSecondWait));
    }

    const task = requestQueue.shift();
    if (!task) break;

    lastDispatchTime = Date.now();
    requestTimestamps.push(lastDispatchTime);
    activeRequests++;

    processRequest(task).finally(() => {
      activeRequests--;
      maybeRestoreConcurrency();

      if (requestQueue.length > 0 && !isProcessing) {
        processQueue();
      }
    });
  }

  isProcessing = false;

  if (requestQueue.length > 0) {
    processQueue();
  }
}

async function processRequest(requestTask: RequestTask): Promise<void> {
  const startTime = Date.now();
  try {
    const result = await requestTask.task();
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('mal', responseTime, true);
    requestTask.resolve(result);
  } catch (error: any) {
    const isRateLimit = error.response?.status === 429;
    const isTimeout = error.code && (
        error.code.includes('TIMEOUT') ||
        error.code.includes('UND_ERR_HEADERS_TIMEOUT') ||
        error.code.includes('UND_ERR_BODY_TIMEOUT')
    );
    const isRetryable = (isRateLimit || isTimeout) && requestTask.retries < MAX_RETRIES;

    if (isRetryable) {
      requestTask.retries++;

      if (isRateLimit) {
        onRateLimitHit();

        const recentHitCount = rateLimitHitTimestamps.length;
        let baseBackoffTime = Math.pow(2, requestTask.retries - 1) * RATE_LIMIT_DELAY;
        if (recentHitCount > 10) baseBackoffTime *= 2.5;
        else if (recentHitCount > 5) baseBackoffTime *= 1.8;
        const jitter = Math.random() * 300;
        const totalDelay = baseBackoffTime + jitter;

        logger.warn(
          `Jikan rate limit hit (${recentHitCount} hits in last 60s). Retrying in ${Math.round(totalDelay)}ms. ` +
          `(Attempt ${requestTask.retries}/${MAX_RETRIES})`
        );

        const requestTracker = require('./requestTracker');
        requestTracker.logError('warning', `MAL API rate limit hit`, {
          retries: requestTask.retries,
          backoffTime: Math.round(totalDelay),
          url: requestTask.url
        });

        setTimeout(() => {
          requestQueue.unshift(requestTask);
          if (!isProcessing) processQueue();
        }, totalDelay);

      } else if (isTimeout) {
        const timeoutDelay = Math.pow(2, requestTask.retries - 1) * 1000;
        const totalDelay = timeoutDelay + (Math.random() * 500);
        logger.warn(
          `Jikan request timeout for "${requestTask.url}". Retrying in ${Math.round(totalDelay)}ms.`
        );
        setTimeout(() => {
          requestQueue.unshift(requestTask);
          if (!isProcessing) processQueue();
        }, totalDelay);
      }
    } else {
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('mal', responseTime, false);
      if (requestTask.retries >= MAX_RETRIES) {
        logger.error(`Jikan request failed for "${requestTask.url}" after ${MAX_RETRIES} retries.`);
        requestTracker.logError('error', `MAL API request failed`, {
           status: error.response?.status,
           message: error.message
        });
      }
      requestTask.reject(error);
    }
  }
}

function enqueueRequest(task: () => Promise<any>, url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    requestQueue.push({ resolve, reject, task, url, retries: 0 });
    if (!isProcessing) {
      processQueue();
    }
  });
}

async function _makeJikanRequest(url: string): Promise<any> {
  const etagKey = `mal_etag:${url}`;

  let etag: string | null = null;
  if (redis) {
      etag = await redis.get(etagKey);
  }

  const headers: Record<string, string> = {};
  if (etag) {
    headers['If-None-Match'] = etag;
  }

  const response = await httpGet(url, {
      dispatcher: malDispatcher,
      headers: headers,
      timeout: 15000,
      validateStatus: (status: number) => (status >= 200 && status < 300) || status === 304
  });

  if (response.status === 304) {
       if (redis) {
           const cachedBody = await redis.get(`mal_cache:${url}`);
           if (cachedBody) {
               logger.debug(`[304] Using Redis cached body for ${url}`);
               return { data: JSON.parse(cachedBody) };
           }
       }
       logger.warn(`[304] ETag match but body missing for ${url}. Re-fetching without ETag...`);
       return httpGet(url, { dispatcher: malDispatcher, timeout: 15000, headers: {} });
  }

  if (response.headers?.etag && redis) {
      const TTL = 25 * 60 * 60;
      await redis.set(etagKey, response.headers.etag, 'EX', TTL);
      await redis.set(`mal_cache:${url}`, JSON.stringify(response.data), 'EX', TTL);
  }

  return response;
}

async function searchAnime(type: string, query: string, limit: number = 25, config: any = {}, page: number = 1): Promise<any[]> {
  let url = `${JIKAN_API_BASE}/anime?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}`;
  if (config.sfw) {
    url += `&sfw=true`;
  }

  let queryType: string | null;
  switch (type) {
    case "movie": queryType = 'movie'; break;
    case "tv": queryType = 'tv'; break;
    case "anime": queryType = null; break;
    default: queryType = null;
  }
  if (queryType) {
    url += `&type=${queryType}`;
  }
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => normalizeJikanCatalogForCache(response.data?.data || []))
    .catch((e: any) => {
      logger.error(`A critical error occurred while searching for anime with query "${query}"`, e.message);
      return [];
    });
}

async function getAnimeDetails(malId: string | number): Promise<any> {
  const url = `${JIKAN_API_BASE}/anime/${malId}/full`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => {
      const data = response.data?.data || null;
      return data ? normalizeJikanAnimeDetailsForCache(data) : null;
    })
    .catch(() => null);
}

async function getAnimeEpisodes(malId: string | number): Promise<any[]> {
  const results = await jikanGetAllPages(`/anime/${malId}/episodes`);
  return normalizeJikanAnimeEpisodesForCache(results);
}

async function getAnimeEpisodeVideos(malId: string | number): Promise<any[]> {
  const results = await jikanGetAllPages(`/anime/${malId}/videos/episodes`);
  return results;
}

async function getAnimeCharacters(malId: string | number): Promise<any[]> {
  const url = `${JIKAN_API_BASE}/anime/${malId}/characters`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => normalizeJikanAnimeCharactersForCache(response.data?.data || []))
    .catch((e: any) => {
      logger.warn(`Could not fetch characters for MAL ID ${malId}:`, e.message);
      return [];
    });
}

async function getAnimeByVoiceActor(personId: string | number): Promise<any[]> {
  const url = `${JIKAN_API_BASE}/people/${personId}/full`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => response.data?.data?.voices || [])
    .catch((e: any) => {
      logger.warn(`Could not fetch roles for person ID ${personId}:`, e.message);
      return [];
    });
}

async function jikanPaginator(endpoint: string, totalItemsToFetch: number, queryParams: Record<string, any> = {}): Promise<any[]> {
  const JIKAN_PAGE_LIMIT = 25;
  const desiredPages = Math.ceil(totalItemsToFetch / JIKAN_PAGE_LIMIT);
  let allItems: any[] = [];

  function _fetchPage(page: number): Promise<any> {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(JIKAN_PAGE_LIMIT),
      ...queryParams
    });
    const url = `${JIKAN_API_BASE}${endpoint}?${params.toString()}`;
    return enqueueRequest(() => _makeJikanRequest(url), url)
      .then((response: any) => response.data || { data: [], pagination: {} })
      .catch((e: any) => {
        logger.warn(`Could not fetch page ${page} for endpoint ${endpoint}:`, e.message);
        return { data: [], pagination: {} };
      });
  }

  const firstPageResponse = await _fetchPage(1);
  if (!firstPageResponse.data || firstPageResponse.data.length === 0) {
    return [];
  }
  allItems.push(...firstPageResponse.data);

  const lastVisiblePage = firstPageResponse.pagination?.last_visible_page || 1;
  const actualTotalPagesToFetch = Math.min(desiredPages, lastVisiblePage);

  if (actualTotalPagesToFetch > 1) {
    const pagePromises: Promise<any[]>[] = [];
    for (let page = 2; page <= actualTotalPagesToFetch; page++) {
      pagePromises.push(
        _fetchPage(page).then((result: any) => result?.data || [])
      );
    }
    const results = await Promise.all(pagePromises);
    for (const pageData of results) {
      if (pageData.length > 0) {
        allItems.push(...pageData);
      }
    }
  }

  return allItems.slice(0, totalItemsToFetch);
}

async function jikanGetAllPages(endpoint: string, initialParams: Record<string, any> = {}): Promise<any[]> {
  let allItems: any[] = [];

  const firstParams = new URLSearchParams({ ...initialParams, page: '1' });
  const firstUrl = `${JIKAN_API_BASE}${endpoint}?${firstParams.toString()}`;

  try {
    const firstResponse = await enqueueRequest(() => _makeJikanRequest(firstUrl), firstUrl);
    const firstData = firstResponse.data;

    if (!firstData?.data || firstData.data.length === 0) return [];
    allItems.push(...firstData.data);

    const hasNextPage = firstData.pagination?.has_next_page || false;
    const lastPage = firstData.pagination?.last_visible_page || 1;

    if (!hasNextPage || lastPage <= 1) return allItems;

    const pagePromises: Promise<any[]>[] = [];
    for (let page = 2; page <= lastPage; page++) {
      const params = new URLSearchParams({ ...initialParams, page: String(page) });
      const url = `${JIKAN_API_BASE}${endpoint}?${params.toString()}`;
      pagePromises.push(
        enqueueRequest(() => _makeJikanRequest(url), url)
          .then((response: any) => response.data?.data || [])
          .catch((error: any) => {
            logger.warn(`Failed to fetch page ${page} for endpoint ${endpoint}:`, error.message || error);
            return [];
          })
      );
    }

    const results = await Promise.all(pagePromises);
    for (const pageData of results) {
      allItems.push(...pageData);
    }
  } catch (error: any) {
    logger.warn(`Failed to fetch first page for endpoint ${endpoint}:`, error.message || error);
  }

  return allItems;
}

async function getAiringSchedule(day: string, page: number = 1, config: any = {}): Promise<any[]> {
  const queryParams: Record<string, any> = {
    filter: day.toLowerCase(),
    page: page
  };

  if (config.sfw) {
    queryParams.sfw = true;
  }

  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/schedules?${params.toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => normalizeJikanCatalogForCache(response.data?.data || []))
    .catch((e: any) => {
      logger.warn(`Could not fetch airing schedule for ${day}, page ${page}:`, e.message);
      return [];
    });
}

async function getAiringNow(page: number = 1, config: any = {}): Promise<any[]> {
  const queryParams: Record<string, any> = {
    page: page
  };
  if (config.sfw) {
    queryParams.sfw = true;
  }
  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/seasons/now?${params.toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => normalizeJikanCatalogForCache(response.data?.data || []))
    .catch((e: any) => {
      logger.warn(`Could not fetch currently airing anime, page ${page}:`, e.message);
      return [];
    });
}

async function getUpcoming(page: number = 1, config: any = {}): Promise<any[]> {
  const queryParams: Record<string, any> = {
    page: page
  };
  if (config.sfw) {
    queryParams.sfw = true;
  }
  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/seasons/upcoming?${params.toString()}`;

  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => normalizeJikanCatalogForCache(response.data?.data || []))
    .catch((e: any) => {
      logger.warn(`Could not fetch upcoming anime , page ${page}:`, e.message);
      return [];
    });
}

async function getAnimeByGenre(genreId: number | string, typeFilter: string | null = null, page: number = 1, config: any = {}): Promise<any[]> {
  const queryParams: Record<string, any> = {
    genres: genreId,
    order_by: 'members',
    sort: 'desc',
    page: page,
  };

  if (typeFilter) {
    let jikanType = typeFilter.toLowerCase();
    if (jikanType === 'series') {
      jikanType = 'tv';
    }
    if (genreId !== 12) {
      queryParams.type = jikanType;
    }
  }

  if (config.sfw) {
    queryParams.sfw = true;
  }
  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/anime?${params.toString()}`;
  try {
    const response = await enqueueRequest(() => _makeJikanRequest(url), url);
    const animeList = response.data?.data || [];

    const desiredTypes = new Set(['tv', 'movie', 'ova', 'ona']);
    const filtered = animeList.filter((anime: any) => anime.type && desiredTypes.has(anime.type.toLowerCase()));
    return normalizeJikanCatalogForCache(filtered);

  } catch (error: any) {
    logger.error(`Jikan API Error: Could not fetch anime for genre ID ${genreId}, page ${page}. URL: ${url}`, error.message);
    return [];
  }
}

async function getAnimeGenres(): Promise<any[]> {
  const url = `${JIKAN_API_BASE}/genres/anime`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => response.data?.data || [])
    .catch((e: any) => {
      logger.error(`Could not fetch anime genres from Jikan`, e.message);
      return [];
    });
}

async function getTopAnimeByDateRange(startDate: string, endDate: string, page: number = 1, genreId?: string | number, config: any = {}): Promise<any[]> {
  const queryParams: Record<string, any> = {
    start_date: startDate,
    end_date: endDate,
    order_by: 'members',
    sort: 'desc',
    page: page,
  };

  if (genreId) {
    queryParams.genres = genreId;
  }

  if (config.sfw) {
    queryParams.sfw = true;
  }

  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/anime?${params.toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => normalizeJikanCatalogForCache(response.data?.data || []))
    .catch((e: any) => {
      logger.warn(`Could not fetch top anime between ${startDate} and ${endDate}, page ${page}:`, e.message);
      return [];
  });
}

async function getTopAnimeByType(type: string, page: number = 1, config: any = {}): Promise<any[]> {
  const types = ['movie', 'tv', 'ova', 'ona'];
  const queryParams: Record<string, any> = {
    page: page,
  };
  if (types.includes(type)) {
    queryParams.type = type;
  }

  if (config.sfw) {
    queryParams.sfw = true;
  }

  const url = `${JIKAN_API_BASE}/top/anime?${new URLSearchParams(queryParams).toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => normalizeJikanCatalogForCache(response.data?.data || []))
    .catch((e: any) => {
      logger.warn(`Could not fetch top  anime, page ${page}:`, e.message);
      return [];
    });
}

async function getTopAnimeByFilter(filter: string, page: number = 1, config: any = {}): Promise<any[]> {
  const queryParams: Record<string, any> = {
    page: page,
    filter: filter
  };

  if (config.sfw) {
    queryParams.sfw = true;
  }

  const url = `${JIKAN_API_BASE}/top/anime?${new URLSearchParams(queryParams).toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => normalizeJikanCatalogForCache(response.data?.data || []))
    .catch((e: any) => {
      logger.warn(`Could not fetch top anime by filter ${filter}, page ${page}:`, e.message);
      return [];
    });
}

async function getStudios(limit: number = 100): Promise<any[]> {
  const queryParams: Record<string, any> = {
    order_by: 'favorites',
    sort: 'desc'
  };
  const endpoint = `/producers`;
  return jikanPaginator(endpoint, limit, queryParams);
}

async function getAnimeByStudio(studioId: string | number, page: number = 1, limit: number = 25): Promise<any[]> {
  const url = `${JIKAN_API_BASE}/anime?producers=${studioId}&order_by=members&sort=desc&page=${page}&limit=${limit}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => normalizeJikanCatalogForCache(response.data?.data || []))
    .catch((e: any) => {
      logger.warn(`Could not fetch anime for studio ID ${studioId}:`, e.message);
      return [];
    });
}

async function getAnimeBySeason(year: number, season: string, page: number = 1, config: any = {}): Promise<any[]> {
  const queryParams: Record<string, any> = {
    page: page
  };
  if (config.sfw) {
    queryParams.sfw = true;
  }
  const params = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/seasons/${year}/${season}?${params.toString()}`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => normalizeJikanCatalogForCache(response.data?.data || []))
    .catch((e: any) => {
      logger.warn(`Could not fetch anime for ${season} ${year}, page ${page}:`, e.message);
      return [];
    });
}

async function getAvailableSeasons(): Promise<any[]> {
  const url = `${JIKAN_API_BASE}/seasons`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then((response: any) => response.data?.data || [])
    .catch((e: any) => {
      logger.error(`Could not fetch available seasons:`, e.message);
      return [];
    });
}

async function fetchDiscover(params: Record<string, any> = {}, page: number = 1): Promise<{ items: any[]; hasMore: boolean; total: number; currentPage: number }> {
  const JIKAN_PAGE_LIMIT = 25;
  const queryParams: Record<string, any> = {
    page: page,
    limit: JIKAN_PAGE_LIMIT,
  };

  if (params.order_by) queryParams.order_by = params.order_by;
  if (params.sort) queryParams.sort = params.sort;
  if (params.type) queryParams.type = params.type;
  if (params.status) queryParams.status = params.status;
  if (params.rating) queryParams.rating = params.rating;
  if (params.genres) queryParams.genres = String(params.genres);
  if (params.genres_exclude) queryParams.genres_exclude = String(params.genres_exclude);
  if (params.producers) queryParams.producers = String(params.producers);
  if (params.min_score && Number(params.min_score) > 0) queryParams.min_score = Number(params.min_score);
  if (params.max_score && Number(params.max_score) < 10) queryParams.max_score = Number(params.max_score);

  let resolvedStartDate = params.start_date;
  let resolvedEndDate = params.end_date;
  let resolvedStatus = queryParams.status;
  if (params.season) {
    const isCurrent = params.season === 'CURRENT';
    let season = params.season;
    let year: number | null = params.seasonYear ? Number(params.seasonYear) : null;
    if (isCurrent) {
      const now = new Date();
      const month = now.getUTCMonth() + 1;
      if (month >= 4 && month <= 6) season = 'SPRING';
      else if (month >= 7 && month <= 9) season = 'SUMMER';
      else if (month >= 10 && month <= 12) season = 'FALL';
      else season = 'WINTER';
      year = now.getUTCFullYear();
    }
    const seasonRanges: Record<string, [string, string]> = {
      WINTER: ['01-01', '03-31'],
      SPRING: ['04-01', '06-30'],
      SUMMER: ['07-01', '09-30'],
      FALL: ['10-01', '12-31'],
    };
    if (seasonRanges[season] && year) {
      const [startMonthDay, endMonthDay] = seasonRanges[season];
      resolvedStartDate = `${year}-${startMonthDay}`;
      if (isCurrent) {
        resolvedEndDate = undefined;
        if (!resolvedStatus) resolvedStatus = 'airing';
      } else {
        resolvedEndDate = `${year}-${endMonthDay}`;
      }
    }
  }

  if (resolvedStartDate) queryParams.start_date = resolvedStartDate;
  if (resolvedEndDate) queryParams.end_date = resolvedEndDate;
  if (resolvedStatus) queryParams.status = resolvedStatus;

  if (params.sfw === true || params.sfw === 'true') {
    queryParams.sfw = true;
  }

  const urlParams = new URLSearchParams(queryParams);
  const url = `${JIKAN_API_BASE}/anime?${urlParams.toString()}`;

  try {
    const response = await enqueueRequest(() => _makeJikanRequest(url), url);
    let animeList = response.data?.data || [];
    const pagination = response.data?.pagination || {};

    return {
      items: normalizeJikanCatalogForCache(animeList),
      hasMore: pagination.has_next_page || false,
      total: pagination.items?.total || animeList.length,
      currentPage: pagination.current_page || page,
    };
  } catch (error: any) {
    logger.error(`[MAL Discover] Error fetching discover: ${error.message}`);
    throw error;
  }
}

export {
  searchAnime,
  getAnimeDetails,
  getAnimeEpisodes,
  getAnimeEpisodeVideos,
  getAnimeCharacters,
  getAnimeByVoiceActor,
  getAnimeByGenre,
  getAnimeGenres,
  getAiringNow,
  getUpcoming,
  getTopAnimeByType,
  getTopAnimeByFilter,
  getTopAnimeByDateRange,
  getAiringSchedule,
  getStudios,
  getAnimeByStudio,
  getAnimeBySeason,
  getAvailableSeasons,
  fetchDiscover,
};
module.exports = {
  searchAnime,
  getAnimeDetails,
  getAnimeEpisodes,
  getAnimeEpisodeVideos,
  getAnimeCharacters,
  getAnimeByVoiceActor,
  getAnimeByGenre,
  getAnimeGenres,
  getAiringNow,
  getUpcoming,
  getTopAnimeByType,
  getTopAnimeByFilter,
  getTopAnimeByDateRange,
  getAiringSchedule,
  getStudios,
  getAnimeByStudio,
  getAnimeBySeason,
  getAvailableSeasons,
  fetchDiscover,
  getMemoryStats: () => ({ etagCache: etagCache.size }),
};
