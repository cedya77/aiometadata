import fs from 'fs';
import path from 'path';
const { parse } = require('csv-parse/sync');
const { redis } = require('./getCache');
const { request } = require('undici');

const REMOTE_SERIES_URL = 'https://raw.githubusercontent.com/0xConstant1/Wikidata-Fetcher/refs/heads/main/data/tv_mappings.csv';
const REMOTE_MOVIES_URL = 'https://raw.githubusercontent.com/0xConstant1/Wikidata-Fetcher/refs/heads/main/data/movie_mappings.csv';
const SERIES_CACHE = path.join(__dirname, '..', 'data', 'tv_mappings.csv.cache');
const MOVIES_CACHE = path.join(__dirname, '..', 'data', 'movie_mappings.csv.cache');

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

async function downloadCsv(url: string, cachePath: string, etagKey: string): Promise<string> {
  // Check ETag first
  if (redis && redis.status === 'ready') {
    try {
      const savedEtag = await redis.get(etagKey);
      if (savedEtag && fs.existsSync(cachePath)) {
        const { statusCode, headers } = await request(url, { method: 'HEAD' });
        const remoteEtag = headers.etag;
        if (savedEtag === remoteEtag) {
          console.log(`[Wiki Mapper] Using cache: ${cachePath}`);
          return fs.readFileSync(cachePath, 'utf8');
        }
      }
    } catch (error) {
      console.warn(`[Wiki Mapper] ETag check failed: ${error.message}`);
    }
  }

  // Download fresh data using undici for speed
  console.log(`[Wiki Mapper] Downloading: ${url}`);
  const { statusCode, headers, body } = await request(url);
  
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

async function initialize() {
  if (isInitialized) return;

  try {
    const [seriesCsv, moviesCsv] = await Promise.all([
      downloadCsv(REMOTE_SERIES_URL, SERIES_CACHE, 'tv_mappings_etag'),
      downloadCsv(REMOTE_MOVIES_URL, MOVIES_CACHE, 'movie_mappings_etag')
    ]);

    loadMappings(seriesCsv, { imdb: seriesImdbToAll, tvdb: seriesTvdbToAll, tmdb: seriesTmdbToAll, tvmaze: seriesTvmazeToAll });
    loadMappings(moviesCsv, { imdb: moviesImdbToAll, tvdb: moviesTvdbToAll, tmdb: moviesTmdbToAll });


    isInitialized = true;
    console.log('[Wiki Mapper] Initialization complete');
  } catch (error) {
    console.error('[Wiki Mapper] Initialization failed:', error);
    throw error;
  }
}

// Lookup functions
export async function getSeriesByImdb(imdbId: string): Promise<IdMap | undefined> {
  await initialize();
  return seriesImdbToAll.get(imdbId);
}

export async function getMovieByImdb(imdbId: string): Promise<IdMap | undefined> {
  await initialize();
  return moviesImdbToAll.get(imdbId);
}

export async function getSeriesByTmdb(tmdbId: string): Promise<IdMap | undefined> {
  await initialize();
  const tmdbIdNum = parseInt(tmdbId);
  return isNaN(tmdbIdNum) ? undefined : seriesTmdbToAll.get(tmdbIdNum);
}

export async function getMovieByTmdb(tmdbId: string): Promise<IdMap | undefined> {
  await initialize();
  const tmdbIdNum = parseInt(tmdbId);
  return isNaN(tmdbIdNum) ? undefined : moviesTmdbToAll.get(tmdbIdNum);
}

export async function getSeriesByTvdb(tvdbId: string): Promise<IdMap | undefined> {
  await initialize();
  const tvdbIdNum = parseInt(tvdbId);
  return isNaN(tvdbIdNum) ? undefined : seriesTvdbToAll.get(tvdbIdNum);
}

export async function getMovieByTvdb(tvdbId: string): Promise<IdMap | undefined> {
  await initialize();
  const tvdbIdNum = parseInt(tvdbId);
  return isNaN(tvdbIdNum) ? undefined : moviesTvdbToAll.get(tvdbIdNum);
}

export async function getSeriesByTvmaze(tvmazeId: string): Promise<IdMap | undefined> {
  await initialize();
  const tvmazeIdNum = parseInt(tvmazeId);
  return isNaN(tvmazeIdNum) ? undefined : seriesTvmazeToAll.get(tvmazeIdNum);
}

// Generic lookup functions that return all IDs at once
export async function getByTvdbId(tvdbId: string): Promise<IdMap | undefined> {
  await initialize();
  const tvdbIdNum = parseInt(tvdbId);
  return isNaN(tvdbIdNum) ? undefined : seriesTvdbToAll.get(tvdbIdNum);
}

export async function getByTmdbId(tmdbId: string, type: 'series' | 'movie' = 'series'): Promise<IdMap | undefined> {
  await initialize();
  
  const tmdbIdNum = parseInt(tmdbId);
  if (isNaN(tmdbIdNum)) return undefined;
  
  if (type === 'series') {
    return seriesTmdbToAll.get(tmdbIdNum);
  } else {
    return moviesTmdbToAll.get(tmdbIdNum);
  }
}

export async function getByImdbId(imdbId: string, type: 'series' | 'movie' = 'series'): Promise<IdMap | undefined> {
  await initialize();
  if (type === 'series') {
    return seriesImdbToAll.get(imdbId);
  } else {
    return moviesImdbToAll.get(imdbId);
  }
}

export async function initializeMappings() {
  await initialize();
}

export async function getMappingStats() {
  await initialize();
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
  getMappingStats
};

