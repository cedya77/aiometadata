// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { httpGet } from './httpClient.js';

const { getSetting }: any = require('../lib/settingsService');

export type LumiereList = 'popular' | 'trending';

const LIST_PAGE_LIMIT = 50;

export function lumiereApiBase(): string {
  return String(getSetting('LUMIERE_API_BASE') || '').trim();
}

export function lumiereListOf(catalogId: string): LumiereList | null {
  if (catalogId === 'lumiere.popular') return 'popular';
  if (catalogId === 'lumiere.trending') return 'trending';
  return null;
}

export async function fetchLumiereList(
  baseUrl: string,
  list: LumiereList,
  type: string,
  genre: string,
  timeoutMs: number
): Promise<string[]> {
  const ids: string[] = [];
  let cursor = '';
  for (;;) {
    const params = new URLSearchParams({ type: type === 'movie' ? 'movies' : 'series', limit: String(LIST_PAGE_LIMIT) });
    if (genre) params.set('genres', genre);
    if (cursor) params.set('cursor', cursor);
    const response: any = await httpGet(`${baseUrl.replace(/\/+$/, '')}/lists/${list}?${params}`, { timeout: timeoutMs });
    const items = response?.data?.items;
    if (!Array.isArray(items)) {
      throw new Error(`LumiereDB returned no result list (status ${response?.status})`);
    }
    for (const item of items) {
      if (typeof item?.tconst === 'string' && item.tconst.startsWith('tt')) ids.push(item.tconst);
    }
    cursor = response?.data?.meta?.nextCursor || '';
    if (!response?.data?.meta?.hasMore || !cursor) return ids;
  }
}

export async function fetchLumiereGenres(baseUrl: string, timeoutMs: number): Promise<Record<'movie' | 'series', string[]>> {
  const response: any = await httpGet(`${baseUrl.replace(/\/+$/, '')}/discover/options`, { timeout: timeoutMs });
  const types = response?.data?.types;
  if (!types?.movies || !types?.series) {
    throw new Error(`LumiereDB returned no discover options (status ${response?.status})`);
  }
  const values = (genres: any): string[] =>
    (Array.isArray(genres) ? genres : [])
      .map((genre: any) => genre?.value)
      .filter((value: any): value is string => typeof value === 'string' && value !== '')
      .sort();
  return { movie: values(types.movies.genres), series: values(types.series.genres) };
}

export function lumiereGenreLabel(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part === 'tv' ? 'TV' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-');
}
