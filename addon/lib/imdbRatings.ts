import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import { request } from 'undici';
import { LRUCache } from 'lru-cache';
import consola from 'consola';
import redis from './redisClient';

const logger = consola.withTag('IMDB Ratings');

// Constants
const IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const REDIS_RATINGS_ETAG_KEY = 'imdb-ratings-etag';
const REDIS_RATINGS_HASH = 'imdb:ratings';
const MIN_VOTES = 50;
const LRU_MAX_ENTRIES = 50000;
const NEGATIVE_CACHE_TTL = 86400000; // 24 hours in ms
const REDIS_BATCH_SIZE = 10000;

// Types
export interface ImdbRating {
  rating: number;
  votes: number;
}

export type ContentType = 'movie' | 'series';

// negative cache entries
const NEGATIVE_CACHE_SENTINEL: ImdbRating = { rating: -1, votes: -1 };

// In-memory LRU for hot lookups
const lruCache = new LRUCache<string, ImdbRating>({
  max: LRU_MAX_ENTRIES,
  ttl: 0,
});

// State tracking
let ratingsLoaded = false;
let ratingsCount = 0;

// Stats tracking
let datasetHits = 0;
let redisHits = 0;
let cinemetaFallbackHits = 0;
let cinemetaTotalTime = 0;

/**
 * Check if a cached value is a negative cache sentinel
 */
function isNegativeCacheHit(rating: ImdbRating | undefined): boolean {
  return rating !== undefined && rating.rating === -1 && rating.votes === -1;
}

/**
 * Parse a Redis-stored rating string "rating|votes" into an ImdbRating object
 */
function parseRedisRating(value: string): ImdbRating | null {
  const [ratingStr, votesStr] = value.split('|');
  const rating = parseFloat(ratingStr);
  const votes = parseInt(votesStr, 10);
  if (isNaN(rating) || isNaN(votes)) return null;
  return { rating, votes };
}

/**
 * Encode an ImdbRating to Redis string format "rating|votes"
 */
function encodeRedisRating(rating: ImdbRating): string {
  return `${rating.rating}|${rating.votes}`;
}

/**
 * Downloads and caches IMDb ratings from the official IMDb dataset.
 * Uses streaming decompression to minimize peak memory usage.
 * Stores ratings in Redis hash for persistence, with LRU for hot lookups.
 */
export async function downloadAndCacheIMDbRatings(): Promise<boolean> {
  const isRedisReady = redis?.status === 'ready';

  try {
    // Check if we need to download based on ETag
    if (isRedisReady && redis) {
      const savedEtag = await redis.get(REDIS_RATINGS_ETAG_KEY);

      if (savedEtag) {
        const headResponse = await request(IMDB_RATINGS_URL, {
          method: 'HEAD',
          headers: { 'User-Agent': 'AIOMetadata/1.0' }
        });
        const remoteEtag = headResponse.headers.etag;

        if (savedEtag === remoteEtag && redis) {
          // Check if Redis already has ratings
          const existingCount = await redis.hlen(REDIS_RATINGS_HASH);
          if (existingCount > 0) {
            logger.info('Remote file unchanged (ETag match). Using Redis cache.');
            ratingsLoaded = true;
            ratingsCount = existingCount;
            logger.success(`${existingCount.toLocaleString()} ratings available in Redis.`);
            return true;
          }
        }

        logger.info('Remote file changed or Redis empty. Downloading new ratings...');
      }
    } else {
      logger.warn('Redis not available. IMDb ratings will use Cinemeta fallback only.');
      return false;
    }

    // Download with streaming
    logger.start('Downloading ratings dataset (streaming)...');
    const response = await request(IMDB_RATINGS_URL, {
      method: 'GET',
      headers: { 'User-Agent': 'AIOMetadata/1.0' },
      bodyTimeout: 120000,
      headersTimeout: 60000
    });

    // Clear existing data before repopulating
    if (!redis) return false;
    await redis.del(REDIS_RATINGS_HASH);
    lruCache.clear();

    // Stream decompress and parse line-by-line
    logger.info('Streaming and parsing ratings...');
    const gunzipStream = createGunzip();
    const bodyStream = Readable.from(response.body as AsyncIterable<Uint8Array>);
    const rl = createInterface({
      input: bodyStream.pipe(gunzipStream),
      crlfDelay: Infinity
    });

    let count = 0;
    let filtered = 0;
    let isFirstLine = true;
    let pipeline = redis!.pipeline();

    for await (const line of rl) {
      if (isFirstLine) {
        isFirstLine = false;
        continue; // Skip header
      }
      if (!line.trim()) continue;

      const [id, ratingStr, votesStr] = line.split('\t');
      const rating = parseFloat(ratingStr);
      const votes = parseInt(votesStr, 10);

      if (!id || isNaN(rating) || isNaN(votes)) continue;

      if (votes < MIN_VOTES) {
        filtered++;
        continue;
      }

      // Add to Redis pipeline
      pipeline.hset(REDIS_RATINGS_HASH, id, `${rating}|${votes}`);
      count++;

      // Execute batch to avoid memory buildup
      if (count % REDIS_BATCH_SIZE === 0) {
        await pipeline.exec();
        pipeline = redis!.pipeline();
        if (count % 100000 === 0) {
          logger.debug(`Processed ${count.toLocaleString()} ratings...`);
        }
      }
    }

    // Execute remaining batch
    if (count % REDIS_BATCH_SIZE !== 0) {
      await pipeline.exec();
    }

    logger.debug(`Filtered out ${filtered.toLocaleString()} ratings with < ${MIN_VOTES} votes.`);

    // Save ETag for future checks
    if (response.headers.etag && redis) {
      await redis.set(REDIS_RATINGS_ETAG_KEY, response.headers.etag as string);
    }

    // Write maintenance timestamp
    if (redis) {
      await redis.set('maintenance:last_imdb_ratings_update', Date.now().toString());
    }

    ratingsLoaded = true;
    ratingsCount = count;
    logger.success(`Successfully loaded ${count.toLocaleString()} ratings into Redis.`);
    return true;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to download or process ratings:', errorMessage);
    return false;
  }
}

/**
 * Gets the IMDb rating for a given IMDb ID.
 * Uses 3-tier lookup: L1 (LRU) -> L2 (Redis) -> L3 (Cinemeta fallback)
 */
export async function getImdbRating(imdbId: string, type: ContentType = 'movie'): Promise<ImdbRating | null> {
  if (!imdbId) return null;

  try {
    // L1: LRU Cache
    const cached = lruCache.get(imdbId);
    if (cached !== undefined) {
      if (isNegativeCacheHit(cached)) {
        return null; // Cached negative result
      }
      datasetHits++;
      return cached;
    }

    // L2: Redis
    const isRedisReady = redis?.status === 'ready';
    if (isRedisReady && redis) {
      const redisResult = await redis.hget(REDIS_RATINGS_HASH, imdbId);
      if (redisResult) {
        const rating = parseRedisRating(redisResult);
        if (rating) {
          lruCache.set(imdbId, rating);
          redisHits++;
          return rating;
        }
      }
    }

    // L3: Cinemeta fallback
    logger.debug(`Cache miss for ${imdbId}, falling back to Cinemeta...`);
    const cinemetaStart = performance.now();
    const cinemetaRating = await getCinemetaRating(imdbId, type);
    const cinemetaEnd = performance.now();
    
    // Count all Cinemeta attempts
    cinemetaFallbackHits++;
    cinemetaTotalTime += (cinemetaEnd - cinemetaStart);

    if (cinemetaRating) {
      // Populate both caches
      lruCache.set(imdbId, cinemetaRating);
      if (isRedisReady && redis) {
        await redis.hset(REDIS_RATINGS_HASH, imdbId, encodeRedisRating(cinemetaRating));
      }
      return cinemetaRating;
    }

    // Cache negative result to prevent repeated lookups
    lruCache.set(imdbId, NEGATIVE_CACHE_SENTINEL, { ttl: NEGATIVE_CACHE_TTL });
    return null;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`Error fetching rating for ${imdbId}:`, errorMessage);
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
      headers: { 'User-Agent': 'AIOMetadata/1.0' },
      bodyTimeout: 10000,
      headersTimeout: 10000
    });

    const data = await response.body.json() as {
      meta?: {
        imdbRating?: string;
        imdbVotes?: string;
      };
    };

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
    logger.warn(`Cinemeta fallback failed for ${imdbId}:`, errorMessage);
    return null;
  }
}

/**
 * Gets the IMDb rating as a formatted string
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
    logger.warn('Redis is not available. IMDb ratings will use Cinemeta fallback only.');
    return;
  }

  logger.start('Initializing IMDb ratings...');
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
  const combinedCacheHits = datasetHits + redisHits;
  const totalRequests = combinedCacheHits + cinemetaFallbackHits;
  
  const datasetPercentage = totalRequests > 0 ? parseFloat(((combinedCacheHits / totalRequests) * 100).toFixed(1)) : 0;
  const cinemetaPercentage = totalRequests > 0 ? parseFloat(((cinemetaFallbackHits / totalRequests) * 100).toFixed(1)) : 0;
  const cinemetaAvgTime = cinemetaFallbackHits > 0 ? parseFloat((cinemetaTotalTime / cinemetaFallbackHits).toFixed(2)) : 0;

  return {
    totalRequests,
    datasetHits: combinedCacheHits,
    datasetPercentage,
    datasetAvgTime: 0.01, // LRU + Redis lookups are sub-millisecond
    cinemetaFallbackHits,
    cinemetaPercentage,
    cinemetaAvgTime,
    ratingsLoaded: ratingsCount,
    lruHits: datasetHits,
    redisHits,
    lruSize: lruCache.size
  };
}

/**
 * Force update IMDb ratings
 */
export async function forceUpdateImdbRatings(): Promise<{ success: boolean; message: string; count: number }> {
  logger.info('Force update requested...');

  const isRedisReady = redis?.status === 'ready';

  if (!isRedisReady) {
    return {
      success: false,
      message: 'Redis not available',
      count: 0
    };
  }

  try {
    // Clear ETag to force fresh download
    await redis!.del(REDIS_RATINGS_ETAG_KEY);

    // Clear LRU cache (will contain stale data)
    lruCache.clear();

    const success = await downloadAndCacheIMDbRatings();
    const count = await redis!.hlen(REDIS_RATINGS_HASH);

    // Write maintenance timestamp
    await redis!.set('maintenance:last_imdb_ratings_update', Date.now().toString());

    if (success) {
      logger.success(`Force update completed: ${count.toLocaleString()} ratings`);
      return {
        success: true,
        message: `Updated successfully (${count.toLocaleString()} ratings)`,
        count
      };
    } else {
      return {
        success: false,
        message: 'Force update failed',
        count
      };
    }
  } catch (error: any) {
    logger.error(`Force update failed: ${error.message}`);
    return {
      success: false,
      message: `Force update failed: ${error.message}`,
      count: 0
    };
  }
}

/**
 * Get stats for IMDb Ratings
 */
export function getImdbRatingsStatsForDashboard(): { count: number; initialized: boolean } {
  return {
    count: ratingsCount,
    initialized: ratingsLoaded
  };
}

/**
 * Clear the LRU cache
 */
export function clearLruCache(): void {
  lruCache.clear();
  logger.info('LRU cache cleared.');
}
