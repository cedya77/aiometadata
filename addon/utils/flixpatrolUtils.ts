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


const ISO_TO_SLUG: Record<string, string> = {
  al: 'albania', dz: 'algeria', ag: 'antigua-and-barbuda', ar: 'argentina',
  am: 'armenia', au: 'australia', at: 'austria', az: 'azerbaijan', bs: 'bahamas',
  bh: 'bahrain', bd: 'bangladesh', by: 'belarus', be: 'belgium', bz: 'belize',
  bo: 'bolivia', ba: 'bosnia-and-herzegovina', bw: 'botswana', br: 'brazil',
  bg: 'bulgaria', kh: 'cambodia', ca: 'canada', cl: 'chile', co: 'colombia',
  cr: 'costa-rica', hr: 'croatia', cy: 'cyprus', cz: 'czech-republic',
  dk: 'denmark', dm: 'dominica', do: 'dominican-republic', ec: 'ecuador',
  eg: 'egypt', ee: 'estonia', fi: 'finland', fr: 'france', gm: 'gambia',
  de: 'germany', gh: 'ghana', gr: 'greece', gt: 'guatemala', hn: 'honduras',
  hk: 'hong-kong', hu: 'hungary', is: 'iceland', in: 'india', id: 'indonesia',
  iq: 'iraq', ie: 'ireland', il: 'israel', it: 'italy', jm: 'jamaica',
  jp: 'japan', jo: 'jordan', kz: 'kazakhstan', ke: 'kenya', kw: 'kuwait',
  la: 'laos', lv: 'latvia', lb: 'lebanon', ly: 'libya', lt: 'lithuania',
  lu: 'luxembourg', my: 'malaysia', mt: 'malta', mr: 'mauritania', mu: 'mauritius',
  mx: 'mexico', md: 'moldova', mn: 'mongolia', me: 'montenegro', ma: 'morocco',
  mz: 'mozambique', na: 'namibia', nl: 'netherlands', nz: 'new-zealand',
  ni: 'nicaragua', ne: 'niger', ng: 'nigeria', mk: 'north-macedonia',
  no: 'norway', om: 'oman', pk: 'pakistan', pa: 'panama', py: 'paraguay',
  pe: 'peru', ph: 'philippines', pl: 'poland', pt: 'portugal', qa: 'qatar',
  ro: 'romania', sv: 'salvador', sa: 'saudi-arabia', rs: 'serbia', sg: 'singapore',
  sk: 'slovakia', si: 'slovenia', za: 'south-africa', kr: 'south-korea',
  es: 'spain', lk: 'sri-lanka', se: 'sweden', ch: 'switzerland', tw: 'taiwan',
  tj: 'tajikistan', th: 'thailand', tt: 'trinidad-and-tobago', tn: 'tunisia',
  tr: 'turkey', ug: 'uganda', ua: 'ukraine', ae: 'united-arab-emirates',
  gb: 'united-kingdom', us: 'united-states', uy: 'uruguay', ve: 'venezuela',
  vn: 'vietnam', ye: 'yemen', zw: 'zimbabwe',
};

async function fetchRegionData(regionSlug: string): Promise<CrawlerData> {
  const resolved = ISO_TO_SLUG[regionSlug.toLowerCase()] || regionSlug;
  const cacheKey = `flixpatrol-region:${resolved}`;

  return cacheWrapGlobal(cacheKey, async () => {
    const fileSlug = resolved === 'world' ? 'global' : resolved;
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
          config.userUUID || '',
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
