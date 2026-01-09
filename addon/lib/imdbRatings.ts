import * as zlib from 'zlib';
import { promisify } from 'util';
import { request } from 'undici';
import redis from './redisClient';

const gunzip = promisify(zlib.gunzip);

const IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const REDIS_RATINGS_ETAG_KEY = 'imdb-ratings-etag';
const MIN_VOTES = 100; // Minimum votes required to include a rating

// Types
export interface ImdbRating {
  rating: number;
  votes: number;
}

export type ContentType = 'movie' | 'series';

// In-memory storage for ratings
const ratingsMap = new Map<string, ImdbRating>();

let ratingsLoaded = false;
let ratingsCount = 0;

// Stats tracking
let datasetHits = 0;
let cinemetaFallbackHits = 0;
let datasetTotalTime = 0; // Total time for dataset lookups in ms
let cinemetaTotalTime = 0; // Total time for Cinemeta lookups in ms

/**
 * Downloads and caches IMDb ratings from the official IMDb dataset.
 * Uses Redis and ETags to check if the remote file has changed.
 * Stores ratings in-memory Map. Filters out ratings with less than 100 votes.
 */
export async function downloadAndCacheIMDbRatings(): Promise<boolean> {
  const useRedisCache = redis;

  try {
    // Check if we need to download based on ETag
    if (useRedisCache && useRedisCache.status === 'ready') {
      const savedEtag = await useRedisCache.get(REDIS_RATINGS_ETAG_KEY);
      
      if (savedEtag) {
        // Check if remote file has changed
        const headResponse = await request(IMDB_RATINGS_URL, {
          method: 'HEAD',
          headers: { 'User-Agent': 'AIOMetadata/1.0' }
        });
        const remoteEtag = headResponse.headers.etag;
        
        if (savedEtag === remoteEtag && ratingsMap.size > 0) {
          console.log('[IMDb Ratings] Remote file unchanged (ETag match). Using in-memory ratings.');
          ratingsLoaded = true;
          console.log(`[IMDb Ratings] ${ratingsMap.size} ratings available in memory.`);
          return true;
        }
        
        console.log('[IMDb Ratings] Remote file changed (ETag mismatch). Downloading new ratings...');
      }
    } else {
      console.log('[IMDb Ratings] Redis cache is disabled. Proceeding to download.');
    }

    // Download the gzipped TSV file
    console.log('[IMDb Ratings] Downloading ratings dataset...');
    const response = await request(IMDB_RATINGS_URL, {
      method: 'GET',
      headers: { 'User-Agent': 'AIOMetadata/1.0' },
      bodyTimeout: 60000, // 60 seconds timeout
      headersTimeout: 60000
    });

    // Read the response body as a buffer
    const gzippedData = await response.body.arrayBuffer();

    // Decompress the gzip data
    console.log('[IMDb Ratings] Decompressing data...');
    const decompressed = await gunzip(Buffer.from(gzippedData));
    const text = decompressed.toString('utf-8');

    // Parse and store the ratings
    console.log('[IMDb Ratings] Parsing and storing ratings in memory...');
    const lines = text.split('\n');
    let count = 0;
    let filtered = 0;

    // Clear existing ratings map
    ratingsMap.clear();

    // Skip header line (index 0)
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      const [id, ratingStr, votesStr] = line.split('\t');
      const rating = parseFloat(ratingStr);
      const votes = parseInt(votesStr, 10);

      if (!id || isNaN(rating) || isNaN(votes)) continue;

      // Filter out ratings with less than MIN_VOTES
      if (votes < MIN_VOTES) {
        filtered++;
        continue;
      }

      // Store in memory map
      ratingsMap.set(id, { rating, votes });
      count++;
    }

    console.log(`[IMDb Ratings] Filtered out ${filtered} ratings with < ${MIN_VOTES} votes.`);

    // Save the new ETag
    if (useRedisCache && useRedisCache.status === 'ready' && response.headers.etag) {
      await useRedisCache.set(REDIS_RATINGS_ETAG_KEY, response.headers.etag as string);
    }
    
    // Write maintenance timestamp
    if (useRedisCache && useRedisCache.status === 'ready') {
      await useRedisCache.set('maintenance:last_imdb_ratings_update', Date.now().toString());
    }

    ratingsLoaded = true;
    ratingsCount = count;
    console.log(`[IMDb Ratings] Successfully loaded ${count} ratings into memory.`);
    return true;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[IMDb Ratings] Failed to download or process ratings:', errorMessage);
    return false;
  }
}

/**
 * Gets the IMDb rating for a given IMDb ID from in-memory Map.
 * Falls back to Cinemeta if not found in dataset.
 */
export async function getImdbRating(imdbId: string, type: ContentType = 'movie'): Promise<ImdbRating | null> {
  if (!imdbId) {
    return null;
  }

  try {
    // Check in-memory map first
    const datasetStart = performance.now();
    const rating = ratingsMap.get(imdbId);
    const datasetEnd = performance.now();
    
    if (rating) {
      datasetHits++;
      datasetTotalTime += (datasetEnd - datasetStart);
      return rating;
    }
    
    // Fallback to Cinemeta
    const consola = require('consola');
    consola.debug(`[IMDb Ratings] Rating not found in dataset for ${imdbId}, falling back to Cinemeta...`);
    const cinemetaStart = performance.now();
    const cinemetaRating = await getCinemetaRating(imdbId, type);
    const cinemetaEnd = performance.now();
    
    if (cinemetaRating) {
      cinemetaFallbackHits++;
      cinemetaTotalTime += (cinemetaEnd - cinemetaStart);
    }
    
    return cinemetaRating;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[IMDb Ratings] Error fetching rating for ${imdbId}:`, errorMessage);
    return null;
  }
}

/**
 * Fallback to Cinemeta for ratings not in the dataset
 */
async function getCinemetaRating(imdbId: string, type: ContentType): Promise<ImdbRating | null> {
  try {
    const url = `https://cinemeta-live.strem.io/meta/${type}/${imdbId}.json`;
    const response = await request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'AIOMetadata/1.0' }
    });
    
    const data = await response.body.json() as any;
    const rating = data?.meta?.imdbRating;
    const votes = data?.meta?.imdbVotes;
    
    if (rating) {
      return {
        rating: parseFloat(rating),
        votes: votes ? parseInt(votes.replace(/,/g, ''), 10) : 0
      };
    }
    
    return null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn(`[IMDb Ratings] Cinemeta fallback failed for ${imdbId}:`, errorMessage);
    return null;
  }
}

/**
 * Gets the IMDb rating as a formatted string (for backward compatibility)
 */
export async function getImdbRatingString(imdbId: string, type: ContentType = 'movie'): Promise<string | undefined> {
  const result = await getImdbRating(imdbId, type);
  return result ? String(result.rating) : undefined;
}

/**
 * Initialize ratings on startup
 */
export async function initializeRatings(): Promise<void> {
  if (!redis) {
    console.log('[IMDb Ratings] Redis is not available. IMDb ratings will not be loaded.');
    return;
  }

  console.log('[IMDb Ratings] Initializing IMDb ratings...');
  await downloadAndCacheIMDbRatings();
}

/**
 * Get whether ratings are loaded
 */
export function isRatingsLoaded(): boolean {
  return ratingsLoaded;
}

/**
 * Get the count of loaded ratings
 */
export function getRatingsCount(): number {
  return ratingsCount;
}

/**
 * Get IMDb ratings statistics
 */
export function getRatingsStats() {
  const totalRequests = datasetHits + cinemetaFallbackHits;
  const datasetPercentage = totalRequests > 0 ? ((datasetHits / totalRequests) * 100).toFixed(1) : 0;
  const cinemetaPercentage = totalRequests > 0 ? ((cinemetaFallbackHits / totalRequests) * 100).toFixed(1) : 0;
  
  // Calculate average times
  const datasetAvgTime = datasetHits > 0 ? (datasetTotalTime / datasetHits).toFixed(2) : 0;
  const cinemetaAvgTime = cinemetaFallbackHits > 0 ? (cinemetaTotalTime / cinemetaFallbackHits).toFixed(2) : 0;
  
  return {
    totalRequests,
    datasetHits,
    cinemetaFallbackHits,
    datasetPercentage,
    cinemetaPercentage,
    datasetAvgTime: parseFloat(datasetAvgTime as string), // Average time in ms
    cinemetaAvgTime: parseFloat(cinemetaAvgTime as string), // Average time in ms
    ratingsLoaded: ratingsMap.size
  };
}

/**
 * Force update IMDb ratings (bypasses ETag check)
 * @returns Result object with success, message, and count
 */
export async function forceUpdateImdbRatings(): Promise<{ success: boolean; message: string; count: number }> {
  console.log('[IMDb Ratings] Force update requested...');
  
  // Clear existing ETag to force fresh download
  if (redis && redis.status === 'ready') {
    try {
      await redis.del(REDIS_RATINGS_ETAG_KEY);
    } catch (error: any) {
      console.warn(`[IMDb Ratings] Failed to clear ETag: ${error.message}`);
    }
  }
  
  try {
    const success = await downloadAndCacheIMDbRatings();
    
    // Write maintenance timestamp
    if (redis && redis.status === 'ready') {
      await redis.set('maintenance:last_imdb_ratings_update', Date.now().toString());
    }
    
    if (success) {
      console.log(`[IMDb Ratings] Force update completed: ${ratingsMap.size} ratings`);
      return { 
        success: true, 
        message: `Updated successfully (${ratingsMap.size.toLocaleString()} ratings)`,
        count: ratingsMap.size
      };
    } else {
      return { 
        success: false, 
        message: 'Force update failed',
        count: ratingsMap.size
      };
    }
  } catch (error: any) {
    console.error(`[IMDb Ratings] Force update failed: ${error.message}`);
    return { 
      success: false, 
      message: `Force update failed: ${error.message}`,
      count: ratingsMap.size
    };
  }
}

/**
 * Get stats for IMDb Ratings (for dashboard display)
 * @returns Stats object with count and initialized status
 */
export function getImdbRatingsStatsForDashboard(): { count: number; initialized: boolean } {
  return {
    count: ratingsMap.size,
    initialized: ratingsLoaded
  };
}

