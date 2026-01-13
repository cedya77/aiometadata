import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { Readable } from 'stream';
import { request } from 'undici';
import consola from 'consola';
import redis from './redisClient';

const logger = consola.withTag('IMDB Ratings');

// Constants
const IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const REDIS_RATINGS_ETAG_KEY = 'imdb-ratings-etag';
const REDIS_RATINGS_HASH = 'imdb:ratings';
const MIN_VOTES = 20;
const REDIS_BATCH_SIZE = 10000;

// Types
export interface ImdbRating {
  rating: number;
  votes: number;
}

// State tracking
let ratingsLoaded = false;
let ratingsCount = 0;

// Stats tracking
let totalRequests = 0;
let cacheHits = 0;
let cacheMisses = 0;

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
 * Downloads and caches IMDb ratings from the official IMDb dataset.
 * Uses streaming decompression to minimize peak memory usage.
 * Stores ratings in Redis hash for persistence.
 */
export async function downloadAndCacheIMDbRatings(): Promise<boolean> {
  const isRedisReady = redis?.status === 'ready';

  try {
    if (isRedisReady && redis) {
      const savedEtag = await redis.get(REDIS_RATINGS_ETAG_KEY);

      if (savedEtag) {
        const headResponse = await request(IMDB_RATINGS_URL, {
          method: 'HEAD',
          headers: { 'User-Agent': 'AIOMetadata/1.0' }
        });
        const remoteEtag = headResponse.headers.etag;

        if (savedEtag === remoteEtag && redis) {
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
      logger.warn('Redis not available. IMDb ratings will not be available.');
      return false;
    }

    logger.start('Downloading ratings dataset (streaming)...');
    const response = await request(IMDB_RATINGS_URL, {
      method: 'GET',
      headers: { 'User-Agent': 'AIOMetadata/1.0' },
      bodyTimeout: 120000,
      headersTimeout: 60000
    });

    if (!redis) return false;
    
    // Clear existing data before repopulating
    await redis.del(REDIS_RATINGS_HASH);

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
        continue;
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

      pipeline.hset(REDIS_RATINGS_HASH, id, `${rating}|${votes}`);
      count++;

      if (count % REDIS_BATCH_SIZE === 0) {
        await pipeline.exec();
        pipeline = redis!.pipeline();
        if (count % 100000 === 0) {
          logger.debug(`Processed ${count.toLocaleString()} ratings...`);
        }
      }
    }

    if (count % REDIS_BATCH_SIZE !== 0) {
      await pipeline.exec();
    }

    logger.debug(`Filtered out ${filtered.toLocaleString()} ratings with < ${MIN_VOTES} votes.`);

    if (response.headers.etag && redis) {
      await redis.set(REDIS_RATINGS_ETAG_KEY, response.headers.etag as string);
    }

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
 */
export async function getImdbRating(imdbId: string): Promise<ImdbRating | null> {
  if (!imdbId) return null;

  try {
    totalRequests++;
    
    const isRedisReady = redis?.status === 'ready';
    if (isRedisReady && redis) {
      const result = await redis.hget(REDIS_RATINGS_HASH, imdbId);
      if (result) {
        const rating = parseRedisRating(result);
        if (rating) {
          cacheHits++;
          return rating;
        }
      }
    }

    cacheMisses++;
    return null;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`Error fetching rating for ${imdbId}:`, errorMessage);
    return null;
  }
}

/**
 * Gets the IMDb rating as a formatted string
 */
export async function getImdbRatingString(imdbId: string): Promise<string | undefined> {
  const result = await getImdbRating(imdbId);
  return result ? String(result.rating) : undefined;
}

/**
 * Initialize ratings on startup
 */
export async function initializeRatings(): Promise<void> {
  if (!redis) {
    logger.warn('Redis is not available. IMDb ratings will not be available.');
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
  const hitPercentage = totalRequests > 0 ? parseFloat(((cacheHits / totalRequests) * 100).toFixed(1)) : 0;
  const missPercentage = totalRequests > 0 ? parseFloat(((cacheMisses / totalRequests) * 100).toFixed(1)) : 0;

  return {
    totalRequests,
    datasetHits: cacheHits,
    datasetPercentage: hitPercentage,
    datasetMisses: cacheMisses,
    missPercentage,
    ratingsLoaded: ratingsCount
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
    await redis!.del(REDIS_RATINGS_ETAG_KEY);

    const success = await downloadAndCacheIMDbRatings();
    const count = await redis!.hlen(REDIS_RATINGS_HASH);

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
 * Get stats for IMDb Ratings (dashboard)
 */
export function getImdbRatingsStatsForDashboard(): { count: number; initialized: boolean } {
  return {
    count: ratingsCount,
    initialized: ratingsLoaded
  };
}
