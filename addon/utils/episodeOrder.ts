// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const ORDERS = new Set(['official', 'default', 'dvd', 'absolute', 'alternate', 'regional', 'alttwo', 'altdvd']);

// TVDB's episodes endpoint answers these orders with no episodes; only their seasons hold them.
const SEASON_READ_ORDERS = new Set(['alttwo', 'altdvd']);

export type SeasonNumbering = 'years' | 'sequential';

export function readsBySeason(order: string | null | undefined): boolean {
  return !!order && SEASON_READ_ORDERS.has(order);
}

function mapAt(config: any, field: string): Record<string, string> | null {
  const map = config?.[field];
  return map && typeof map === 'object' && !Array.isArray(map) ? map : null;
}

function isSeasonNumbering(value: unknown): value is SeasonNumbering {
  return value === 'years' || value === 'sequential';
}

export function episodeOrderOverride(config: any, tvdbId: string | number | null | undefined): string | null {
  const map = mapAt(config, 'tvdbEpisodeOrders');
  if (!map || !tvdbId) return null;
  const value = map[`tvdb:${tvdbId}`];
  return typeof value === 'string' && ORDERS.has(value) ? value : null;
}

export function withEpisodeOrder<T extends Record<string, any>>(config: T, tvdbId: string | number | null | undefined): T {
  const order = episodeOrderOverride(config, tvdbId);
  return order && order !== config?.tvdbSeasonType ? { ...config, tvdbSeasonType: order } : config;
}

export function seasonNumberingFor(config: any, tvdbId: string | number | null | undefined): SeasonNumbering {
  const own = tvdbId ? mapAt(config, 'tvdbShowSeasonNumbering')?.[`tvdb:${tvdbId}`] : undefined;
  if (isSeasonNumbering(own)) return own;
  return config?.tvdbNormalizeYearSeasons === false ? 'years' : 'sequential';
}

// Null for the default, so keys built from it stay where they are for default users.
export function seasonNumberingProfile(config: any): { years: boolean; shows: Array<[string, SeasonNumbering]> } | null {
  const shows = Object.entries(mapAt(config, 'tvdbShowSeasonNumbering') ?? {})
    .filter((entry): entry is [string, SeasonNumbering] => entry[0].startsWith('tvdb:') && isSeasonNumbering(entry[1]))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const years = config?.tvdbNormalizeYearSeasons === false;
  return years || shows.length ? { years, shows } : null;
}

export function countShowSettings(config: any): number {
  const shows = new Set<string>();
  for (const [key, value] of Object.entries(mapAt(config, 'tvdbEpisodeOrders') ?? {})) {
    if (key.startsWith('tvdb:') && ORDERS.has(value)) shows.add(key);
  }
  for (const [key, value] of Object.entries(mapAt(config, 'tvdbShowSeasonNumbering') ?? {})) {
    if (key.startsWith('tvdb:') && isSeasonNumbering(value)) shows.add(key);
  }
  return shows.size;
}
