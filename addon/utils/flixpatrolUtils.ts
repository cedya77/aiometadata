// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { httpGet, BOOTSTRAP_HTTP_OPTIONS } from "./httpClient.js";
import { cacheWrapGlobal, cacheWrapMetaSmart } from "../lib/getCache.js";
import { getMeta } from "../lib/getMeta.js";
import { UserConfig } from "../types/index.js";
import {
  ChartVariant,
  CrawlerData,
  findChart,
  collectVariants,
} from "./flixpatrolChart.js";
const consola = require('consola');

const logger = consola.withTag('FlixPatrol');

function catalogBaseUrl(): string {
  return process.env.FLIXPATROL_CATALOG_URL
    || 'https://raw.githubusercontent.com/0xConstant1/fp-crawler/main/catalogs';
}

function availabilityUrl(): string {
  return `${catalogBaseUrl()}/availability.json`;
}

const CRAWLER_REFRESH_HOUR = 16;
const CRAWLER_REFRESH_MINUTE = 0;

// Timestamp (ms) of the most recent crawler-refresh boundary that has already passed.
function lastCrawlerRefresh(): number {
  const boundary = new Date();
  boundary.setUTCHours(CRAWLER_REFRESH_HOUR, CRAWLER_REFRESH_MINUTE, 0, 0);
  if (boundary.getTime() > Date.now()) {
    boundary.setUTCDate(boundary.getUTCDate() - 1);
  }
  return boundary.getTime();
}

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
    const url = `${catalogBaseUrl()}/${fileSlug}.json`;
    logger.info(`Fetching region data: ${url}`);
    const response: any = await httpGet(url);
    const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    logger.debug(`Fetched ${data.charts?.length || 0} charts for ${regionSlug} (date: ${data.date})`);
    return data;
  }, getFlixPatrolTTL(), { upstream: true, sourceList: true });
}

export interface FlixPatrolSections {
  hasMovies: boolean;
  hasShows: boolean;
  hasOverall: boolean;
  movieVariants?: ChartVariant[];
  seriesVariants?: ChartVariant[];
  overallVariants?: ChartVariant[];
}

export async function probeFlixPatrolSections(service: string, countrySlug: string): Promise<FlixPatrolSections> {
  try {
    const data = await fetchRegionData(countrySlug);
    const hasChart = (id: string) =>
      data.charts.some(c => c.catalog_id === id && c.entries.length > 0);

    const movieVariants = collectVariants(data, service, 'movies');
    const seriesVariants = collectVariants(data, service, 'series');
    const overallVariants = collectVariants(data, service, 'overall');

    return {
      hasMovies: hasChart(`${service}.movies`),
      hasShows: hasChart(`${service}.series`),
      hasOverall: hasChart(`${service}.overall`),
      ...(movieVariants.length ? { movieVariants } : {}),
      ...(seriesVariants.length ? { seriesVariants } : {}),
      ...(overallVariants.length ? { overallVariants } : {}),
    };
  } catch {
    return { hasMovies: false, hasShows: false, hasOverall: false };
  }
}

// A small precomputed map of which (region, service) pairs exist, with section flags and variant ids
export interface FlixPatrolAvailability {
  schema_version?: number;
  generated_at?: string;
  variantLabels?: Record<string, string>;
  regions: Record<string, Record<string, Record<string, string[]>>>;
}

let availabilityIndex: FlixPatrolAvailability | null = null;
let availabilityFetchedAt = 0;
let availabilityInFlight: Promise<void> | null = null;

async function fetchAvailabilityIndex(): Promise<FlixPatrolAvailability | null> {
  // Startup index fetch; a blip here disables availability for the whole run.
  const response: any = await httpGet(availabilityUrl(), BOOTSTRAP_HTTP_OPTIONS);
  const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  if (!data || typeof data !== 'object' || !data.regions) {
    logger.warn(`Availability index at ${availabilityUrl()} has no "regions" field — ignoring`);
    return null;
  }
  return data as FlixPatrolAvailability;
}


export async function initializeFlixPatrolAvailability(): Promise<void> {
  try {
    const data = await fetchAvailabilityIndex();
    if (data) {
      availabilityIndex = data;
      availabilityFetchedAt = Date.now();
      logger.success(`Loaded FlixPatrol availability index (${Object.keys(data.regions).length} regions)`);
    } else {
      logger.info('FlixPatrol availability index unavailable — config UI will fall back to probing');
    }
  } catch (err: any) {
    logger.info(`FlixPatrol availability index not loaded (${err?.message || err}) — config UI will fall back to probing`);
  }
}

function refreshAvailabilityIfStale(): void {
  // Refresh only if we haven't fetched since the last daily crawler boundary
  const stale = !availabilityIndex || availabilityFetchedAt < lastCrawlerRefresh();
  if (!stale || availabilityInFlight) return;
  availabilityInFlight = (async () => {
    try {
      const data = await fetchAvailabilityIndex();
      if (data) {
        availabilityIndex = data;
        availabilityFetchedAt = Date.now();
      }
    } catch {
      // keep last-known-good
    } finally {
      availabilityInFlight = null;
    }
  })();
}

/** Returns the cached availability index, kicking off a background refresh if stale. */
export function getFlixPatrolAvailability(): FlixPatrolAvailability | null {
  refreshAvailabilityIfStale();
  return availabilityIndex;
}


export async function getFlixPatrolMetas(
  service: string,
  countrySlug: string,
  mediaType: string,
  language: string,
  config: UserConfig,
  includeVideos: boolean = false,
  variantId?: string
): Promise<any[]> {
  const data = await fetchRegionData(countrySlug);
  const chart = findChart(data, service, mediaType, variantId);

  if (!chart || chart.entries.length === 0) {
    const label = variantId ? `${service}.${mediaType}.${variantId}` : `${service}.${mediaType}`;
    logger.warn(`No chart found for ${label} in ${countrySlug}`);
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
