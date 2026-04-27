import { httpGet } from "./httpClient.js";
import { cacheWrapGlobal, cacheWrapMetaSmart } from "../lib/getCache.js";
import { getMeta } from "../lib/getMeta.js";
import { UserConfig } from "../types/index.js";
const consola = require('consola');

const logger = consola.withTag('FlixPatrol');

const CATALOG_BASE_URL = process.env.FLIXPATROL_CATALOG_URL
  || 'https://raw.githubusercontent.com/0xConstant1/fp-crawler/main/catalogs';

const CRAWLER_REFRESH_HOUR = 16;
const CRAWLER_REFRESH_MINUTE = 0;

function getFlixPatrolTTL(): number {
  const override = process.env.FLIXPATROL_TTL;
  if (override) return parseInt(override, 10);

  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(CRAWLER_REFRESH_HOUR, CRAWLER_REFRESH_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return Math.floor((next.getTime() - now.getTime()) / 1000);
}

interface CrawlerEntry {
  rank: number;
  title: string;
  tmdb: {
    id: number;
    media_type: 'movie' | 'tv';
    release_date: string;
  } | null;
}

interface CrawlerChart {
  catalog_id: string;
  heading: string;
  category: string;
  platform: string;
  date: string;
  title_count: number;
  entries: CrawlerEntry[];
}

interface CrawlerData {
  source: string;
  region: string;
  date: string;
  scraped_at_utc: string;
  charts: CrawlerChart[];
}


async function fetchRegionData(regionSlug: string): Promise<CrawlerData> {
  const cacheKey = `flixpatrol-region:${regionSlug}`;

  return cacheWrapGlobal(cacheKey, async () => {
    const fileSlug = regionSlug === 'world' ? 'global' : regionSlug;
    const url = `${CATALOG_BASE_URL}/${fileSlug}.json`;
    logger.info(`Fetching region data: ${url}`);
    const response: any = await httpGet(url);
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    logger.debug(`Fetched ${data.charts?.length || 0} charts for ${regionSlug} (date: ${data.date})`);
    return data;
  }, getFlixPatrolTTL(), { skipVersion: true });
}

function findChart(data: CrawlerData, service: string, mediaType: string): CrawlerChart | null {

  const categorySuffix = mediaType === 'series' ? 'series' : mediaType === 'all' ? 'overall' : 'movies';
  const catalogId = `${service}.${categorySuffix}`;

  let chart = data.charts.find(c => c.catalog_id === catalogId) || null;

  if (!chart && mediaType === 'all') {
    chart = data.charts.find(c => c.catalog_id === `${service}.overall-from-amazon-channels`) || null;
  }

  if (!chart && mediaType !== 'all') {
    chart = data.charts.find(c => c.catalog_id === `${service}.overall`)
      || data.charts.find(c => c.catalog_id === `${service}.overall-from-amazon-channels`)
      || null;
  }

  return chart;
}


export async function probeFlixPatrolSections(service: string, countrySlug: string): Promise<{ hasMovies: boolean; hasShows: boolean; hasOverall: boolean }> {
  try {
    const data = await fetchRegionData(countrySlug);
    const hasOverallChart = (id: string) =>
      data.charts.some(c => c.catalog_id === id && c.entries.length > 0);
    return {
      hasMovies: hasOverallChart(`${service}.movies`),
      hasShows: hasOverallChart(`${service}.series`),
      hasOverall: hasOverallChart(`${service}.overall`) || hasOverallChart(`${service}.overall-from-amazon-channels`),
    };
  } catch {
    return { hasMovies: false, hasShows: false, hasOverall: false };
  }
}


export async function getFlixPatrolMetas(
  service: string,
  countrySlug: string,
  mediaType: string,
  language: string,
  config: UserConfig,
  includeVideos: boolean = false
): Promise<any[]> {
  const data = await fetchRegionData(countrySlug);
  const chart = findChart(data, service, mediaType);

  if (!chart || chart.entries.length === 0) {
    logger.warn(`No chart found for ${service}.${mediaType} in ${countrySlug}`);
    return [];
  }

  logger.info(`Processing ${chart.entries.length} entries from ${chart.catalog_id} (${countrySlug})`);

  const metas = await Promise.all(
    chart.entries.map(async (entry) => {
      try {
        if (!entry.tmdb?.id) {
          logger.debug(`No TMDB ID for "${entry.title}", skipping`);
          return null;
        }

        const stremioType = entry.tmdb.media_type === 'tv' ? 'series' : 'movie';
        const stremioId = `tmdb:${entry.tmdb.id}`;

        const result = await cacheWrapMetaSmart(
          config.userUUID,
          stremioId,
          async () => {
            return await getMeta(stremioType, language, stremioId, config, config.userUUID, includeVideos);
          },
          undefined,
          { enableErrorCaching: true, maxRetries: 2, config },
          stremioType as any,
          includeVideos
        );

        if (result?.meta) return result.meta;
        return null;
      } catch (error: any) {
        logger.error(`Error processing "${entry.title}": ${error.message}`);
        return null;
      }
    })
  );

  const validMetas = metas.filter(Boolean);
  logger.debug(`Resolved ${validMetas.length}/${chart.entries.length} entries for ${chart.catalog_id}`);
  return validMetas;
}
