// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import fs from 'fs';
import path from 'path';
import consola from 'consola';
const redis = require('./redisClient');
const { request } = require('undici');
const logger = consola.withTag('ID Mappings');

export interface MappingSource {
  name: string;
  url: string;
  cachePath: string;
  etagKey: string;
}

const DATA_DIR = path.join(process.cwd(), 'addon', 'data');
const DINS_BASE = 'https://raw.githubusercontent.com/0xConstant1/dins-mappings/main';
const WIKI_BASE = 'https://raw.githubusercontent.com/0xConstant1/Wikidata-Fetcher/refs/heads/main/data';

export const SOURCES: Record<'dinsSeries' | 'dinsMovies' | 'wikiSeries' | 'wikiMovies', MappingSource> = {
  dinsSeries: { name: 'dins series', url: `${DINS_BASE}/tv_mappings.csv`, cachePath: path.join(DATA_DIR, 'dins_tv_mappings.csv.cache'), etagKey: 'dins_tv_mappings_etag' },
  dinsMovies: { name: 'dins movies', url: `${DINS_BASE}/movie_mappings.csv`, cachePath: path.join(DATA_DIR, 'dins_movie_mappings.csv.cache'), etagKey: 'dins_movie_mappings_etag' },
  wikiSeries: { name: 'Wikidata series', url: `${WIKI_BASE}/tv_mappings.csv`, cachePath: path.join(DATA_DIR, 'tv_mappings.csv.cache'), etagKey: 'tv_mappings_etag' },
  wikiMovies: { name: 'Wikidata movies', url: `${WIKI_BASE}/movie_mappings.csv`, cachePath: path.join(DATA_DIR, 'movie_mappings.csv.cache'), etagKey: 'movie_mappings_etag' },
};

export function readCachedCsv(source: MappingSource): string {
  return fs.readFileSync(source.cachePath, 'utf8');
}

export async function downloadCsv<T>(source: MappingSource, parse: (csv: string) => T, skipIfUnchanged = false, maxRetries = 3): Promise<T | null> {
  const { name, url, cachePath, etagKey } = source;
  // On a scheduled refresh the cache file is what is already loaded, so falling back to it means "no change".
  const fromCache = (reason: string): T | null => {
    logger.warn(`${reason}; using cached ${name}`);
    return skipIfUnchanged ? null : parse(readCachedCsv(source));
  };

  let unchanged = false;
  if (redis && redis.status === 'ready') {
    try {
      const savedEtag = await redis.get(etagKey);
      if (savedEtag && fs.existsSync(cachePath)) {
        const { statusCode, headers, body } = await request(url, { method: 'HEAD' });
        await body.dump();
        if (statusCode === 200 && headers.etag === savedEtag) unchanged = true;
        else if (statusCode === 429) return fromCache('Rate limited (429) on ETag check');
      }
    } catch (error: any) {
      if (fs.existsSync(cachePath)) return fromCache(`ETag check failed (${error.code || error.message})`);
      logger.warn(`ETag check failed for ${name}: ${error.message}`);
    }
  }

  if (unchanged) {
    if (skipIfUnchanged) {
      logger.info(`No changes detected for ${name}`);
      return null;
    }
    try {
      return parse(readCachedCsv(source));
    } catch (error: any) {
      logger.warn(`Cached ${name} is unusable (${error.message}); downloading again`);
    }
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
      logger.info(`Retrying ${name} (attempt ${attempt + 1}/${maxRetries + 1}) after ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } else {
      logger.info(`Downloading ${name}: ${url}`);
    }

    try {
      const { statusCode, headers, body } = await request(url);
      if (statusCode === 429) {
        await body.dump();
        lastError = new Error('HTTP 429');
        continue;
      }
      if (statusCode < 200 || statusCode >= 300) {
        await body.dump();
        throw new Error(`HTTP ${statusCode}`);
      }
      const csv = await body.text();
      // Parse before persisting so a broken upstream file never replaces the last good cache.
      let parsed: T;
      try {
        parsed = parse(csv);
      } catch (parseError: any) {
        logger.warn(`Downloaded ${name} failed to parse: ${parseError.message}`);
        throw parseError;
      }
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, csv);
      if (redis && redis.status === 'ready' && headers.etag) await redis.set(etagKey, headers.etag);
      return parsed;
    } catch (error: any) {
      lastError = error;
      break;
    }
  }

  if (fs.existsSync(cachePath)) return fromCache(`Download failed (${lastError?.message})`);
  throw lastError || new Error(`Download failed for ${name}`);
}
