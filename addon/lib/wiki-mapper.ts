import fs from 'fs';
import path from 'path';
const { parse } = require('csv-parse/sync');
const redis = require('./redisClient');
const { request } = require('undici');

const REMOTE_SERIES_URL = 'https://raw.githubusercontent.com/0xConstant1/Wikidata-Fetcher/refs/heads/main/data/tv_mappings.csv';
const REMOTE_MOVIES_URL = 'https://raw.githubusercontent.com/0xConstant1/Wikidata-Fetcher/refs/heads/main/data/movie_mappings.csv';
const SERIES_CACHE = path.join(process.cwd(), 'addon', 'data', 'tv_mappings.csv.cache');
const MOVIES_CACHE = path.join(process.cwd(), 'addon', 'data', 'movie_mappings.csv.cache');
const UPDATE_INTERVAL_HOURS = parseInt(process.env.WIKI_MAPPER_UPDATE_INTERVAL_HOURS || '24'); // Update every 24 hours

interface IdMap {
  imdbId: string;
  tvdbId: string;
  tmdbId: string;
  tvmazeId?: string;
}

// Series maps
const seriesImdbToAll = new Map<string, IdMap>();
const seriesTvdbToAll = new Map<number, IdMap>();
const seriesTmdbToAll = new Map<number, IdMap>();
const seriesTvmazeToAll = new Map<number, IdMap>();

// Movie maps (no TVMaze)
const moviesImdbToAll = new Map<string, IdMap>();
const moviesTvdbToAll = new Map<number, IdMap>();
const moviesTmdbToAll = new Map<number, IdMap>();

let isInitialized = false;
let updateInterval: ReturnType<typeof setInterval> | null = null;

async function downloadCsv(url: string, cachePath: string, etagKey: string, maxRetries: number = 3): Promise<string> {
  // Check ETag first
  if (redis && redis.status === 'ready') {
    try {
      const savedEtag = await redis.get(etagKey);
      if (savedEtag && fs.existsSync(cachePath)) {
        try {
          const { statusCode, headers } = await request(url, { method: 'HEAD' });
          if (statusCode === 200 && headers.etag) {
            const remoteEtag = headers.etag;
            if (savedEtag === remoteEtag) {
              console.log(`[Wiki Mapper] Using cache: ${cachePath}`);
              return fs.readFileSync(cachePath, 'utf8');
            }
          } else if (statusCode === 429) {
            // Rate limited on HEAD request, use cached data
            console.warn(`[Wiki Mapper] Rate limited (429) on ETag check, using cached data: ${cachePath}`);
            return fs.readFileSync(cachePath, 'utf8');
          }
        } catch (error: any) {
          // If HEAD request fails (e.g., network error, 429), check if we have cached data to use
          const statusCode = error.statusCode || (error.response && error.response.statusCode);
          if (statusCode === 429 || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code?.startsWith('UND_ERR_')) {
            console.warn(`[Wiki Mapper] ETag check failed (${statusCode || error.code}), attempting to use cached data`);
            if (fs.existsSync(cachePath)) {
              try {
                const cachedData = fs.readFileSync(cachePath, 'utf8');
                console.log(`[Wiki Mapper] Using cached data due to download error: ${cachePath}`);
                return cachedData;
              } catch (cacheError: any) {
                console.warn(`[Wiki Mapper] Cached data unreadable: ${cacheError.message}`);
              }
            }
          }
          console.warn(`[Wiki Mapper] ETag check failed: ${error.message}`);
        }
      }
    } catch (error: any) {
      console.warn(`[Wiki Mapper] ETag check failed: ${error.message}`);
    }
  }

  // Download fresh data using undici with retry logic for 429 errors
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s, 4s, 8s... (capped at 30s)
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        console.log(`[Wiki Mapper] Retrying download (attempt ${attempt + 1}/${maxRetries + 1}) after ${delay}ms: ${url}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.log(`[Wiki Mapper] Downloading: ${url}`);
      }
      
      const { statusCode, headers, body } = await request(url);
      
      if (statusCode === 429) {
        // Rate limited - will retry if attempts remain
        lastError = new Error(`HTTP ${statusCode}`);
        if (attempt < maxRetries) {
          continue;
        }
        // Last attempt failed with 429, try to use cache
        console.warn(`[Wiki Mapper] Rate limited (429) after ${maxRetries + 1} attempts, falling back to cache`);
        if (fs.existsSync(cachePath)) {
          try {
            const cachedData = fs.readFileSync(cachePath, 'utf8');
            console.log(`[Wiki Mapper] Using cached data after rate limit: ${cachePath}`);
            return cachedData;
          } catch (cacheError: any) {
            console.error(`[Wiki Mapper] Cached data unreadable: ${cacheError.message}`);
            throw lastError;
          }
        }
        throw lastError;
      }
      
      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`HTTP ${statusCode}`);
      }
      
      const csvData = await body.text();

      // Save to cache
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, csvData);

      // Save ETag
      if (redis && redis.status === 'ready' && headers.etag) {
        await redis.set(etagKey, headers.etag);
      }

      return csvData;
    } catch (error: any) {
      lastError = error;
      
      // Check if it's a 429 error (either from statusCode check above or from error message)
      const is429 = error.message?.includes('HTTP 429') || 
                    error.statusCode === 429 || 
                    (error.response && error.response.statusCode === 429);
      
      // If it's a 429 and we have retries left, continue the loop
      if (is429 && attempt < maxRetries) {
        continue;
      }
      
      // If it's not a 429 or we're out of retries, try to use cached data
      if (fs.existsSync(cachePath)) {
        try {
          console.warn(`[Wiki Mapper] Download failed (${error.message}), falling back to cached data: ${cachePath}`);
          const cachedData = fs.readFileSync(cachePath, 'utf8');
          return cachedData;
        } catch (cacheError: any) {
          console.error(`[Wiki Mapper] Cached data also unreadable: ${cacheError.message}`);
        }
      }
      
      // If no cache available or cache read failed, throw the original error
      throw error;
    }
  }
  
  // Should never reach here, but TypeScript needs it
  throw lastError || new Error('Download failed after all retries');
}

function loadMappings(csvData: string, maps: { imdb: Map<string, IdMap>, tvdb: Map<number, IdMap>, tmdb: Map<number, IdMap>, tvmaze?: Map<number, IdMap> }) {
  const records: IdMap[] = parse(csvData, { columns: true });
  
  maps.imdb.clear();
  maps.tvdb.clear();
  maps.tmdb.clear();
  maps.tvmaze?.clear();

  let validCount = 0;
  let invalidCount = 0;


  for (const row of records) {
    let isValid = true;

    // Validate IMDB ID (should start with 'tt' followed by numbers)
    if (row.imdbId && !/^tt\d+$/.test(row.imdbId)) {
      console.warn(`[Wiki Mapper] Invalid IMDB ID: ${row.imdbId}`);
      isValid = false;
    }

    // Validate TMDB ID (should be only numbers)
    if (row.tmdbId && !/^\d+$/.test(row.tmdbId)) {
      console.warn(`[Wiki Mapper] Invalid TMDB ID: ${row.tmdbId}`);
      isValid = false;
    }

    // Validate TVDB ID (should be only numbers)
    if (row.tvdbId && !/^\d+$/.test(row.tvdbId)) {
      console.warn(`[Wiki Mapper] Invalid TVDB ID: ${row.tvdbId}`);
      isValid = false;
    }

    // Validate TVMaze ID (can be numbers or numbers/title format like "31454/velvet-coleccion")
    if (row.tvmazeId && !/^\d+(\/.*)?$/.test(row.tvmazeId)) {
      console.warn(`[Wiki Mapper] Invalid TVMaze ID: ${row.tvmazeId}`);
      isValid = false;
    }

    if (isValid) {
      if (row.imdbId) maps.imdb.set(row.imdbId, row);
      if (row.tvdbId) {
        const tvdbIdNum = parseInt(row.tvdbId);
        if (!isNaN(tvdbIdNum)) {
          maps.tvdb.set(tvdbIdNum, row);
        }
      }
      if (row.tmdbId) {
        const tmdbIdNum = parseInt(row.tmdbId);
        if (!isNaN(tmdbIdNum)) {
          maps.tmdb.set(tmdbIdNum, row);
        }
      }
      if (row.tvmazeId && maps.tvmaze) {
        // Extract numeric ID from TVMaze format (e.g., "31454/velvet-coleccion" -> "31454")
        const tvmazeNumericId = parseInt(row.tvmazeId.split('/')[0]);
        if (!isNaN(tvmazeNumericId)) {
          // Store only the numeric ID in the mapping object
          const cleanRow = { ...row, tvmazeId: tvmazeNumericId.toString() };
          maps.tvmaze.set(tvmazeNumericId, cleanRow);
        }
      }
      validCount++;
    } else {
      invalidCount++;
    }
  }
  
  console.log(`[Wiki Mapper] Loaded ${validCount} valid mappings, skipped ${invalidCount} invalid entries`);
}

async function refreshMappings(): Promise<void> {
  const [seriesCsv, moviesCsv] = await Promise.all([
    downloadCsv(REMOTE_SERIES_URL, SERIES_CACHE, 'tv_mappings_etag'),
    downloadCsv(REMOTE_MOVIES_URL, MOVIES_CACHE, 'movie_mappings_etag')
  ]);

  loadMappings(seriesCsv, { imdb: seriesImdbToAll, tvdb: seriesTvdbToAll, tmdb: seriesTmdbToAll, tvmaze: seriesTvmazeToAll });
  loadMappings(moviesCsv, { imdb: moviesImdbToAll, tvdb: moviesTvdbToAll, tmdb: moviesTmdbToAll });

  if (redis && redis.status === 'ready') {
    await redis.set('maintenance:last_wiki_mapper_update', Date.now().toString());
  }
}

async function initialize() {
  if (isInitialized) return;

  try {
    await refreshMappings();

    isInitialized = true;

    // Schedule periodic updates
    if (!updateInterval) {
      const intervalMs = UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;
      updateInterval = setInterval(async () => {
        console.log(`[Wiki Mapper] Running scheduled update (every ${UPDATE_INTERVAL_HOURS} hours)...`);
        try {
          await refreshMappings();
          console.log('[Wiki Mapper] Scheduled update completed successfully.');
        } catch (error: any) {
          console.error(`[Wiki Mapper] Scheduled update failed: ${error.message}`);
        }
      }, intervalMs);

      console.log(`[Wiki Mapper] Scheduled periodic updates every ${UPDATE_INTERVAL_HOURS} hours.`);
    }

    console.log('[Wiki Mapper] Initialization complete');
  } catch (error: any) {
    const errorMessage = error?.message || String(error);
    console.error(`[Wiki Mapper] Initialization failed: ${errorMessage}`);
    throw new Error(`Wiki Mappings failed to initialize: ${errorMessage}`);
  }
}

// Synchronous lookup functions (require prior initialization via initializeMappings())
// These are performance-critical - eliminating async overhead saves ~15-20ms per lookup

function ensureInitialized(): void {
  if (!isInitialized) {
    throw new Error('Wiki mappings not initialized. Ensure initializeMappings() is called at server startup.');
  }
}

export function getSeriesByImdb(imdbId: string): IdMap | undefined {
  ensureInitialized();
  return seriesImdbToAll.get(imdbId);
}

export function getMovieByImdb(imdbId: string): IdMap | undefined {
  ensureInitialized();
  return moviesImdbToAll.get(imdbId);
}

export function getSeriesByTmdb(tmdbId: string): IdMap | undefined {
  ensureInitialized();
  const tmdbIdNum = parseInt(tmdbId);
  return isNaN(tmdbIdNum) ? undefined : seriesTmdbToAll.get(tmdbIdNum);
}

export function getMovieByTmdb(tmdbId: string): IdMap | undefined {
  ensureInitialized();
  const tmdbIdNum = parseInt(tmdbId);
  return isNaN(tmdbIdNum) ? undefined : moviesTmdbToAll.get(tmdbIdNum);
}

export function getSeriesByTvdb(tvdbId: string): IdMap | undefined {
  ensureInitialized();
  const tvdbIdNum = parseInt(tvdbId);
  return isNaN(tvdbIdNum) ? undefined : seriesTvdbToAll.get(tvdbIdNum);
}

export function getMovieByTvdb(tvdbId: string): IdMap | undefined {
  ensureInitialized();
  const tvdbIdNum = parseInt(tvdbId);
  return isNaN(tvdbIdNum) ? undefined : moviesTvdbToAll.get(tvdbIdNum);
}

export function getSeriesByTvmaze(tvmazeId: string): IdMap | undefined {
  ensureInitialized();
  const tvmazeIdNum = parseInt(tvmazeId);
  return isNaN(tvmazeIdNum) ? undefined : seriesTvmazeToAll.get(tvmazeIdNum);
}

// Generic lookup functions that return all IDs at once
export function getByTvdbId(tvdbId: string): IdMap | undefined {
  ensureInitialized();
  const tvdbIdNum = parseInt(tvdbId);
  return isNaN(tvdbIdNum) ? undefined : seriesTvdbToAll.get(tvdbIdNum);
}

export function getByTmdbId(tmdbId: string, type: 'series' | 'movie' = 'series'): IdMap | undefined {
  ensureInitialized();
  const tmdbIdNum = parseInt(tmdbId);
  if (isNaN(tmdbIdNum)) return undefined;
  
  if (type === 'series') {
    return seriesTmdbToAll.get(tmdbIdNum);
  } else {
    return moviesTmdbToAll.get(tmdbIdNum);
  }
}

export function getByImdbId(imdbId: string, type: 'series' | 'movie' = 'series'): IdMap | undefined {
  ensureInitialized();
  if (type === 'series') {
    return seriesImdbToAll.get(imdbId);
  } else {
    return moviesImdbToAll.get(imdbId);
  }
}

export async function initializeMappings() {
  await initialize();
}

export function getMappingStats() {
  ensureInitialized();
  return {
    series: { imdb: seriesImdbToAll.size, tvdb: seriesTvdbToAll.size, tmdb: seriesTmdbToAll.size, tvmaze: seriesTvmazeToAll.size },
    movies: { imdb: moviesImdbToAll.size, tvdb: moviesTvdbToAll.size, tmdb: moviesTmdbToAll.size }
  };
}

// Main mappings object
export const mappings = {
  getByTvdbId,
  getByTmdbId,
  getByImdbId,
  getSeriesByImdb,
  getMovieByImdb,
  getSeriesByTmdb,
  getMovieByTmdb,
  getSeriesByTvdb,
  getMovieByTvdb,
  getSeriesByTvmaze,
  getStats: getMappingStats
};

/**
 * Force update the Wikidata mappings (bypasses ETag check)
 * @returns {Promise<Object>} Result object with success, message, and counts
 */
export async function forceUpdateWikiMappings(): Promise<{ success: boolean; message: string; seriesCount: number; moviesCount: number }> {
  console.log('[Wiki Mapper] Force update requested...');
  
  // Reset initialization flag to force re-download
  isInitialized = false;
  
  // Clear existing ETags to force fresh download
  if (redis && redis.status === 'ready') {
    try {
      await redis.del('tv_mappings_etag');
      await redis.del('movie_mappings_etag');
    } catch (error: any) {
      console.warn(`[Wiki Mapper] Failed to clear ETags: ${error.message}`);
    }
  }
  
  try {
    const [seriesCsv, moviesCsv] = await Promise.all([
      downloadCsv(REMOTE_SERIES_URL, SERIES_CACHE, 'tv_mappings_etag'),
      downloadCsv(REMOTE_MOVIES_URL, MOVIES_CACHE, 'movie_mappings_etag')
    ]);

    loadMappings(seriesCsv, { imdb: seriesImdbToAll, tvdb: seriesTvdbToAll, tmdb: seriesTmdbToAll, tvmaze: seriesTvmazeToAll });
    loadMappings(moviesCsv, { imdb: moviesImdbToAll, tvdb: moviesTvdbToAll, tmdb: moviesTmdbToAll });

    isInitialized = true;
    
    // Write maintenance timestamp
    if (redis && redis.status === 'ready') {
      await redis.set('maintenance:last_wiki_mapper_update', Date.now().toString());
    }
    
    const seriesCount = seriesImdbToAll.size;
    const moviesCount = moviesImdbToAll.size;
    
    console.log(`[Wiki Mapper] Force update completed: ${seriesCount} series, ${moviesCount} movies`);
    return { 
      success: true, 
      message: `Updated successfully (${seriesCount.toLocaleString()} series, ${moviesCount.toLocaleString()} movies)`,
      seriesCount,
      moviesCount
    };
  } catch (error: any) {
    console.error(`[Wiki Mapper] Force update failed: ${error.message}`);
    return { 
      success: false, 
      message: `Force update failed: ${error.message}`,
      seriesCount: seriesImdbToAll.size,
      moviesCount: moviesImdbToAll.size
    };
  }
}

/**
 * Get stats for the Wiki Mapper (for dashboard display)
 * @returns {Object} Stats object with counts and initialized status
 */
export function getWikiMapperStats(): { seriesCount: number; moviesCount: number; totalCount: number; initialized: boolean; updateIntervalHours: number } {
  return {
    seriesCount: seriesImdbToAll.size,
    moviesCount: moviesImdbToAll.size,
    totalCount: seriesImdbToAll.size + moviesImdbToAll.size,
    initialized: isInitialized,
    updateIntervalHours: UPDATE_INTERVAL_HOURS
  };
}

// CommonJS exports
module.exports = {
  mappings,
  initializeMappings,
  getSeriesByImdb,
  getMovieByImdb,
  getSeriesByTmdb,
  getMovieByTmdb,
  getSeriesByTvdb,
  getMovieByTvdb,
  getSeriesByTvmaze,
  getByTvdbId,
  getByTmdbId,
  getByImdbId,
  getMappingStats,
  forceUpdateWikiMappings,
  getWikiMapperStats
};

