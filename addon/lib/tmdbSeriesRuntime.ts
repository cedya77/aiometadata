// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
export {};

const redis: any = require('./redisClient');
const consola: any = require('consola');

const logger = consola.withTag('TmdbSeriesRuntime');

/**
 * A TMDB series' runtime is the length of its usual episode.
 *
 * TMDB leaves `episode_run_time` empty for most shows, and the last aired
 * episode is often a finale that runs far longer than the rest, so neither is a
 * good answer on its own. When a meta build has the season details in hand the
 * runtime is the median of the regular episodes, and that value is remembered
 * per series so that callers holding only the series details (search results,
 * catalog runtime filters, metas built without episodes) give the same answer.
 */

const KEY_PREFIX = 'tmdb-series-runtime:v1:';
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const STANDARD_EPISODE = 'standard';

function ttlSeconds(): number {
  const parsed = Number.parseInt(process.env.META_TTL || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
}

/** Only positive finite numbers count; numeric strings are accepted. */
function asRuntime(value: any): number | null {
  let minutes: number;
  if (typeof value === 'number') {
    minutes = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    minutes = Number(value);
  } else {
    return null;
  }
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

function episodeTypeOf(episode: any): string {
  return String(episode?.episode_type ?? '').trim().toLowerCase();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The usual episode length across loaded season details, or null when no
 * regular-season episode carries a runtime.
 */
function runtimeFromEpisodes(seasons: any): number | null {
  if (!Array.isArray(seasons)) return null;

  const usual: number[] = [];
  const regular: number[] = [];
  for (const season of seasons) {
    if (!season || !Array.isArray(season.episodes)) continue;
    for (const episode of season.episodes) {
      if (!episode) continue;
      const seasonNumber = Number(episode.season_number ?? season.season_number);
      if (!(seasonNumber > 0)) continue;
      const runtime = asRuntime(episode.runtime);
      if (runtime === null) continue;
      regular.push(runtime);
      const episodeType = episodeTypeOf(episode);
      if (episodeType === '' || episodeType === STANDARD_EPISODE) usual.push(runtime);
    }
  }

  const pool = usual.length > 0 ? usual : regular;
  return pool.length > 0 ? median(pool) : null;
}

/** The best runtime the series details alone can give, or null. */
function runtimeFromDetails(details: any): number | null {
  if (!details || typeof details !== 'object') return null;

  const listed = Array.isArray(details.episode_run_time) ? asRuntime(details.episode_run_time[0]) : null;
  if (listed !== null) return listed;

  const aired = [details.last_episode_to_air, details.next_episode_to_air]
    .map((episode: any) => ({ type: episodeTypeOf(episode), runtime: asRuntime(episode?.runtime) }))
    .filter((episode): episode is { type: string; runtime: number } => episode.runtime !== null);

  const standard = aired.find((episode) => episode.type === STANDARD_EPISODE);
  return (standard ?? aired[0])?.runtime ?? null;
}

function keyFor(tmdbId: any): string | null {
  if (tmdbId === null || tmdbId === undefined) return null;
  const id = String(tmdbId).trim();
  return id ? `${KEY_PREFIX}${id}` : null;
}

async function rememberSeriesRuntime(tmdbId: any, runtime: any): Promise<void> {
  const key = keyFor(tmdbId);
  const value = asRuntime(runtime);
  if (!redis || !key || value === null) return;
  try {
    await redis.set(key, String(value), 'EX', ttlSeconds());
  } catch (error: any) {
    logger.debug(`Could not remember runtime for tmdb:${tmdbId}: ${error?.message || error}`);
  }
}

async function recallSeriesRuntime(tmdbId: any): Promise<number | null> {
  const key = keyFor(tmdbId);
  if (!redis || !key) return null;
  try {
    return asRuntime(await redis.get(key));
  } catch (error: any) {
    logger.debug(`Could not recall runtime for tmdb:${tmdbId}: ${error?.message || error}`);
    return null;
  }
}

/**
 * Runtime in minutes of a TMDB series, or null when nothing usable is known.
 * Pass the loaded season details when there are any; without them the
 * remembered value is used, then the series details.
 */
async function resolveSeriesRuntime(details: any, seasons: any = null): Promise<number | null> {
  const tmdbId = details?.id;

  const fromEpisodes = runtimeFromEpisodes(seasons);
  if (fromEpisodes !== null) {
    // Fire-and-forget: storing the value must never delay the response.
    rememberSeriesRuntime(tmdbId, fromEpisodes).catch((error: any) => {
      logger.debug(`Could not remember runtime for tmdb:${tmdbId}: ${error?.message || error}`);
    });
    return fromEpisodes;
  }

  const remembered = await recallSeriesRuntime(tmdbId);
  if (remembered !== null) return remembered;

  return runtimeFromDetails(details);
}

module.exports = {
  runtimeFromEpisodes,
  runtimeFromDetails,
  rememberSeriesRuntime,
  recallSeriesRuntime,
  resolveSeriesRuntime,
};
