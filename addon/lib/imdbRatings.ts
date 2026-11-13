// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { promises as fs } from 'fs';
import path from 'path';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { pipeline } from 'stream';
import { request } from 'undici';
import consola from 'consola';
import redis from './redisClient';
import { RatingsTable, type ImdbRating } from './imdbRatingsTable';
const buildInfo = require('./buildInfo');

export type { ImdbRating };

const logger = consola.withTag('IMDB Ratings');

// Constants
const IMDB_RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const SNAPSHOT_PATH = path.join(process.cwd(), 'addon', 'data', 'imdb-ratings.bin');
// Where ratings lived before they moved into memory; removed once the table loads.
const LEGACY_REDIS_KEYS = ['imdb:ratings', 'imdb-ratings-etag'];
const UPDATE_INTERVAL_HOURS = parseInt(process.env.IMDB_RATINGS_UPDATE_INTERVAL_HOURS || '24');
const UPDATE_INTERVAL_MS = UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;
const RETRY_BASE_MS = 15 * 60 * 1000;
const MIN_VOTES = 20;

// State tracking
let table: RatingsTable | null = null;
let currentEtag: string | null = null;
let ratingsLoaded = false;
let ratingsUpdateInterval: ReturnType<typeof setInterval> | null = null;
let ratingsCount = 0;
let updateInFlight: Promise<boolean> | null = null;
let inFlightForced = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;
let legacyRedisCopyDropped = false;

// Stats tracking
let totalRequests = 0;
let cacheHits = 0;
let cacheMisses = 0;

function install(next: RatingsTable, etag: string | null): void {
  table = next;
  currentEtag = etag;
  ratingsLoaded = true;
  ratingsCount = next.size;
  void dropLegacyRedisCopy();
}

async function dropLegacyRedisCopy(): Promise<void> {
  if (legacyRedisCopyDropped || redis?.status !== 'ready') return;
  legacyRedisCopyDropped = true;
  try {
    await redis.unlink(...LEGACY_REDIS_KEYS);
  } catch (error) {
    legacyRedisCopyDropped = false;
    logger.debug('Could not remove the old Redis copy of the ratings:', (error as Error).message);
  }
}

async function loadSnapshot(): Promise<boolean> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(SNAPSHOT_PATH);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') logger.warn(`Could not read ${SNAPSHOT_PATH}:`, error.message);
    return false;
  }

  const saved = RatingsTable.fromBuffer(buffer);
  if (!saved) {
    logger.warn('Saved IMDb ratings file is unreadable; downloading a fresh copy.');
    return false;
  }
  install(saved.table, saved.etag);
  return true;
}

async function saveSnapshot(): Promise<void> {
  if (!table) return;
  const tempPath = `${SNAPSHOT_PATH}.tmp`;
  try {
    await fs.mkdir(path.dirname(SNAPSHOT_PATH), { recursive: true });
    await fs.writeFile(tempPath, table.toBuffer(currentEtag));
    await fs.rename(tempPath, SNAPSHOT_PATH);
  } catch (error) {
    logger.warn('Could not save IMDb ratings to disk:', (error as Error).message);
  }
}

async function markUpdated(): Promise<void> {
  if (redis?.status !== 'ready') return;
  try {
    await redis.set('maintenance:last_imdb_ratings_update', Date.now().toString());
  } catch (error) {
    logger.debug('Could not record the ratings update time:', (error as Error).message);
  }
}

/**
 * Downloads the official IMDb ratings dataset into memory and saves it to disk.
 * Skips the download when the loaded copy's ETag still matches, unless forced.
 */
async function downloadAndCacheIMDbRatings(force = false): Promise<boolean> {
  try {
    if (!force && table && currentEtag) {
      const headResponse = await request(IMDB_RATINGS_URL, {
        method: 'HEAD',
        headers: { 'User-Agent': `AIOMetadata/${buildInfo.version}` }
      });
      if (headResponse.headers.etag === currentEtag) {
        logger.info('Remote file unchanged (ETag match). Keeping the loaded ratings.');
        return true;
      }
      logger.info('Remote file changed. Downloading new ratings...');
    }

    logger.start('Downloading ratings dataset (streaming)...');
    const response = await request(IMDB_RATINGS_URL, {
      method: 'GET',
      headers: { 'User-Agent': `AIOMetadata/${buildInfo.version}` },
      bodyTimeout: 120000,
      headersTimeout: 60000
    });

    // pipeline, not pipe: a body error has to reach readline or the parse never ends.
    const decompressed = pipeline(response.body, createGunzip(), () => {});
    const lines = createInterface({ input: decompressed, crlfDelay: Infinity });
    const { table: next, filtered } = await RatingsTable.fromLines(lines, MIN_VOTES);
    logger.debug(`Filtered out ${filtered.toLocaleString()} ratings with < ${MIN_VOTES} votes.`);

    if (next.size === 0) {
      throw new Error('Parsed zero IMDb ratings; keeping the loaded ratings.');
    }

    const etag = response.headers.etag;
    install(next, typeof etag === 'string' ? etag : null);
    await saveSnapshot();
    await markUpdated();

    logger.success(`Successfully loaded ${next.size.toLocaleString()} ratings.`);
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to download or process ratings:', errorMessage);
    return false;
  }
}

function scheduleRetryIfFailed(success: boolean): boolean {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (success) {
    consecutiveFailures = 0;
    return true;
  }

  const delay = Math.min(RETRY_BASE_MS * 2 ** consecutiveFailures, UPDATE_INTERVAL_MS);
  consecutiveFailures++;
  logger.warn(`IMDb ratings update failed; retrying in ${Math.round(delay / 60000)} minutes.`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void runRatingsUpdate();
  }, delay);
  retryTimer.unref?.();
  return false;
}

/** A failed load retries with backoff rather than waiting for the next daily run. */
function runRatingsUpdate(force = false): Promise<boolean> {
  if (updateInFlight) {
    if (!force || inFlightForced) return updateInFlight;
    return updateInFlight.then(() => runRatingsUpdate(true));
  }
  inFlightForced = force;
  updateInFlight = downloadAndCacheIMDbRatings(force)
    .then(scheduleRetryIfFailed)
    .finally(() => { updateInFlight = null; });
  return updateInFlight;
}

/**
 * Gets the IMDb rating for a given IMDb ID.
 */
export async function getImdbRating(imdbId: string): Promise<ImdbRating | null> {
  if (!imdbId) return null;

  totalRequests++;
  const rating = table?.get(imdbId) ?? null;
  if (rating) cacheHits++;
  else cacheMisses++;
  return rating;
}

/**
 * Ratings for a whole page of ids. Returns only the ids that resolved.
 */
export async function getImdbRatingStrings(imdbIds: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const id of new Set(imdbIds.filter(Boolean))) {
    const rating = await getImdbRating(id);
    if (rating) found.set(id, String(rating.rating));
  }
  return found;
}

/**
 * Gets the IMDb rating as a formatted string
 */
export async function getImdbRatingString(imdbId: string): Promise<string | undefined> {
  const result = await getImdbRating(imdbId);
  return result ? String(result.rating) : undefined;
}

/**
 * Initialize ratings on startup: a saved copy is served at once and checked
 * against IMDb in the background; without one, startup waits for the download.
 */
export async function initializeRatings(): Promise<void> {
  logger.start('Initializing IMDb ratings...');
  if (await loadSnapshot()) {
    logger.success(`${ratingsCount.toLocaleString()} ratings loaded from disk.`);
    void runRatingsUpdate();
  } else {
    await runRatingsUpdate();
  }

  // Schedule periodic updates
  if (!ratingsUpdateInterval) {
    ratingsUpdateInterval = setInterval(async () => {
      logger.info(`Running scheduled IMDb ratings update (every ${UPDATE_INTERVAL_HOURS} hours)...`);
      if (await runRatingsUpdate()) {
        logger.success('Scheduled IMDb ratings update completed.');
      }
    }, UPDATE_INTERVAL_MS);
    ratingsUpdateInterval.unref?.();
    logger.info(`Scheduled periodic IMDb ratings updates every ${UPDATE_INTERVAL_HOURS} hours.`);
  }
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

  const success = await runRatingsUpdate(true);
  if (!success) {
    return { success: false, message: 'Force update failed', count: ratingsCount };
  }

  logger.success(`Force update completed: ${ratingsCount.toLocaleString()} ratings`);
  return {
    success: true,
    message: `Updated successfully (${ratingsCount.toLocaleString()} ratings)`,
    count: ratingsCount
  };
}

/**
 * Get stats for IMDb Ratings (dashboard)
 */
export function getImdbRatingsStatsForDashboard(): { count: number; initialized: boolean; updateIntervalHours: number } {
  return {
    count: ratingsCount,
    initialized: ratingsLoaded,
    updateIntervalHours: UPDATE_INTERVAL_HOURS
  };
}
