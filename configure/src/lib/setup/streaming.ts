// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { CatalogConfig } from '@/contexts/config';

const TMDB_DYNAMIC_DATE_TOKEN_PREFIX = '__tmdb_date__';

export const STREAMING_TIME_RANGE_OPTIONS = [
  { value: 'last_month', label: 'Last month' },
  { value: 'last_year', label: 'Last year' },
  { value: 'last_5_years', label: 'Last 5 years' },
  { value: 'last_10_years', label: 'Last 10 years' },
] as const;

export type StreamingTimeRange = (typeof STREAMING_TIME_RANGE_OPTIONS)[number]['value'];

export interface SelectionItem {
  id: number;
  label: string;
}

export interface PopularStreamingService {
  key: string;
  label: string;
  providerIds: number[];
  logo: string;
}

export interface SelectedStreamingService {
  key: string;
  label: string;
  providerIds: number[];
  watchProviders: SelectionItem[];
  region: string;
  source: 'popular' | 'custom';
  logo?: string | null;
}

export interface TmdbWatchRegion {
  iso_3166_1: string;
  english_name?: string;
  native_name?: string;
}

export interface TmdbProvider {
  provider_id: number;
  provider_name: string;
  display_priority?: number;
  logo_path?: string | null;
}

export function tmdbLogoUrl(path: string | null | undefined): string | null {
  return path ? `https://image.tmdb.org/t/p/w92${path}` : null;
}

export const POPULAR_STREAMING_SERVICES: PopularStreamingService[] = [
  { key: 'netflix', label: 'Netflix', providerIds: [8], logo: '/netflix.webp' },
  { key: 'hbo-max', label: 'HBO Max', providerIds: [1899], logo: '/max.webp' },
  { key: 'disney-plus', label: 'Disney+', providerIds: [337], logo: '/disney.webp' },
  { key: 'prime-video', label: 'Prime Video', providerIds: [9], logo: '/prime.webp' },
  { key: 'apple-tv', label: 'Apple TV', providerIds: [350], logo: '/apple.webp' },
  { key: 'paramount', label: 'Paramount', providerIds: [2616, 2303], logo: '/paramount.webp' },
  { key: 'peacock', label: 'Peacock', providerIds: [386, 387], logo: '/peacock.webp' },
  { key: 'hulu', label: 'Hulu', providerIds: [15], logo: '/hulu.webp' },
  { key: 'netflix-kids', label: 'Netflix Kids', providerIds: [175], logo: '/netflixkids.webp' },
  { key: 'crunchyroll', label: 'Crunchyroll', providerIds: [283], logo: '/crunchyroll.webp' },
  { key: 'mubi', label: 'Mubi', providerIds: [11], logo: '/mubi.jpg' },
  { key: 'criterion', label: 'Criterion', providerIds: [258], logo: '/criterionchannel.jpg' },
  { key: 'discovery-plus', label: 'Discovery+', providerIds: [520], logo: '/discovery-plus.webp' },
  { key: 'starz', label: 'Starz', providerIds: [43], logo: '/starz.jpg' },
  { key: 'globoplay', label: 'Globoplay', providerIds: [307], logo: '/globo.webp' },
  { key: 'canal-plus', label: 'Canal+', providerIds: [381], logo: '/canal-plus.webp' },
  { key: 'jiohotstar', label: 'JioHotstar', providerIds: [2336], logo: '/hotstar.webp' },
  { key: 'claro-video', label: 'Claro Video', providerIds: [167], logo: '/claro.webp' },
  { key: 'zee5', label: 'Zee5', providerIds: [232], logo: '/zee5.webp' },
  { key: 'sky-go', label: 'Sky Go', providerIds: [29], logo: '/skygo.jpg' },
  { key: 'rakuten-viki', label: 'Rakuten Viki', providerIds: [344], logo: '/rakuten_viki.webp' },
  { key: 'magellantv', label: 'MagellanTV', providerIds: [551], logo: '/magellan.webp' },
];

function buildDateToken(preset: StreamingTimeRange, bound: 'from' | 'to'): string {
  return `${TMDB_DYNAMIC_DATE_TOKEN_PREFIX}:${preset}:${bound}`;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getStreamingDateRange(preset: StreamingTimeRange): { from: string; to: string } {
  const now = new Date();
  const to = formatLocalDate(now);
  const fromDate = new Date(now);

  switch (preset) {
    case 'last_month':
      fromDate.setDate(fromDate.getDate() - 30);
      break;
    case 'last_5_years':
      fromDate.setFullYear(fromDate.getFullYear() - 5);
      break;
    case 'last_10_years':
      fromDate.setFullYear(fromDate.getFullYear() - 10);
      break;
    case 'last_year':
    default:
      fromDate.setFullYear(fromDate.getFullYear() - 1);
      break;
  }

  return { from: formatLocalDate(fromDate), to };
}

function buildDiscoverWebUrl(
  mediaType: 'movie' | 'tv',
  params: Record<string, string | number | boolean | null | undefined>
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  return `https://www.themoviedb.org/discover/${mediaType}?${search.toString()}`;
}

export interface StreamingCatalogOptions {
  services: SelectedStreamingService[];
  datePreset: StreamingTimeRange;
  releasedOnly: boolean;
  catalogTTL: number;
}

/** Stored params keep date tokens so the window slides; the TMDB link gets real dates. */
export function buildStreamingServiceCatalogs({
  services,
  datePreset,
  releasedOnly,
  catalogTTL,
}: StreamingCatalogOptions): CatalogConfig[] {
  if (services.length === 0) return [];

  const { from, to } = getStreamingDateRange(datePreset);
  const uniqueSuffix = Date.now().toString(36);

  const identityOf = (service: SelectedStreamingService): string => {
    const [source = 'unknown', idPart = service.key] = service.key.split(':');
    return `${source}:${idPart}`;
  };

  const stripRegionSuffix = (label: string, region: string): string => {
    const suffix = ` (${region})`;
    return label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
  };

  const regionsByIdentity = new Map<string, Set<string>>();
  for (const service of services) {
    const identity = identityOf(service);
    if (!regionsByIdentity.has(identity)) regionsByIdentity.set(identity, new Set());
    regionsByIdentity.get(identity)!.add(service.region || '');
  }

  const buildCatalog = (
    provider: { ids: number[]; label: string; region: string; watchProviders: SelectionItem[] },
    mediaType: 'movie' | 'series',
    slug: string,
    index: number
  ): CatalogConfig => {
    const isMovie = mediaType === 'movie';
    const tmdbMediaType = isMovie ? 'movie' : 'tv';

    const commonParams: Record<string, string | number | boolean> = {
      sort_by: 'popularity.desc',
      include_adult: false,
      watch_region: provider.region,
      with_watch_providers: provider.ids.join('|'),
      with_watch_monetization_types: 'flatrate|free|ads|rent|buy',
      'vote_count.gte': 10,
    };

    const params: Record<string, string | number | boolean> = isMovie
      ? {
          ...commonParams,
          'primary_release_date.gte': buildDateToken(datePreset, 'from'),
          'primary_release_date.lte': buildDateToken(datePreset, 'to'),
          ...(releasedOnly
            ? {
                with_release_type: '4|5|6',
                'release_date.lte': `${TMDB_DYNAMIC_DATE_TOKEN_PREFIX}:today:to`,
              }
            : {}),
        }
      : {
          ...commonParams,
          'first_air_date.gte': buildDateToken(datePreset, 'from'),
          'first_air_date.lte': buildDateToken(datePreset, 'to'),
          ...(releasedOnly ? { with_status: '0|3|4|5' } : {}),
        };

    const discoverUrlParams: Record<string, string | number | boolean> = isMovie
      ? {
          ...commonParams,
          'primary_release_date.gte': from,
          'primary_release_date.lte': to,
          ...(releasedOnly ? { with_release_type: '4|5|6', 'release_date.lte': to } : {}),
        }
      : {
          ...commonParams,
          'first_air_date.gte': from,
          'first_air_date.lte': to,
          ...(releasedOnly ? { with_status: '0|3|4|5' } : {}),
        };

    const providerIdsSlug = provider.ids.join('_');

    return {
      id: `tmdb.discover.${isMovie ? 'movie' : 'series'}.streaming_${slug}_${providerIdsSlug}_${index}.${uniqueSuffix}`,
      type: mediaType,
      name: provider.label,
      enabled: true,
      showInHome: true,
      source: 'tmdb',
      ...(catalogTTL < 300 ? { cacheTTL: 300 } : {}),
      metadata: {
        description: `TMDB Discover (${tmdbMediaType})`,
        url: buildDiscoverWebUrl(tmdbMediaType, discoverUrlParams),
        discover: {
          version: 2,
          source: 'tmdb',
          mediaType: tmdbMediaType,
          params,
          formState: {
            catalogName: provider.label,
            discoverSource: 'tmdb',
            catalogType: mediaType,
            tmdbMediaType,
            sortBy: 'popularity.desc',
            includeAdult: false,
            releasedOnly,
            watchRegion: provider.region,
            watchProviders: provider.watchProviders,
            providerJoinMode: 'or',
            voteCountMin: 10,
            ...(isMovie
              ? { primaryReleaseFrom: from, primaryReleaseTo: to, movieDatePreset: datePreset }
              : { firstAirFrom: from, firstAirTo: to, seriesDatePreset: datePreset }),
          },
        },
      },
    };
  };

  const catalogs: CatalogConfig[] = [];
  const seen = new Set<string>();

  services.forEach((service, index) => {
    if (seen.has(service.key)) return;
    seen.add(service.key);

    const regionCount = regionsByIdentity.get(identityOf(service))?.size || 0;
    const baseLabel = stripRegionSuffix(service.label, service.region);
    const providerLabel = regionCount > 1 ? `${baseLabel} (${service.region})` : baseLabel;
    const slug = providerLabel
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 30) || 'service';

    const provider = {
      ids: service.providerIds,
      label: providerLabel,
      region: service.region,
      watchProviders: service.watchProviders,
    };

    catalogs.push(buildCatalog(provider, 'movie', slug, index));
    catalogs.push(buildCatalog(provider, 'series', slug, index));
  });

  return catalogs;
}
