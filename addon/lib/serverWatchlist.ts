// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { mapWithConcurrency } from '../utils/concurrency';
import { envInt } from '../utils/envNumber';

export const SERVER_WATCHLIST_PREFIX = 'aiom.watchlist.';

export const SERVER_WATCHLIST_SORTS = ['added', 'released', 'title', 'imdbrating'] as const;
type Sort = (typeof SERVER_WATCHLIST_SORTS)[number];

const MEDIA_TYPE: Record<string, string> = { movies: 'movie', series: 'series', anime: 'anime', all: 'all' };

export function isServerWatchlistCatalog(catalogId: string): boolean {
  return catalogId.startsWith(SERVER_WATCHLIST_PREFIX);
}

export function serverWatchlistMediaType(catalogId: string): string | undefined {
  return MEDIA_TYPE[catalogId.slice(SERVER_WATCHLIST_PREFIX.length)];
}

function sortOf(config: any, catalogId: string, type: string): Sort {
  const catalog = (config.catalogs || []).find((c: any) => c.id === catalogId && c.type === type)
    || (config.catalogs || []).find((c: any) => c.id === catalogId);
  return (SERVER_WATCHLIST_SORTS as readonly string[]).includes(catalog?.sort) ? catalog.sort : 'added';
}

async function titleMeta(config: any, userUUID: string, row: any): Promise<any | null> {
  const { cacheWrapMetaSmart } = require('./getCache');
  const { getMeta } = require('./getMeta');
  const type = row.media_type === 'movie' || row.meta_type === 'movie' ? 'movie' : 'series';
  const id = String(row.meta_id);
  const result = await cacheWrapMetaSmart(
    userUUID,
    id,
    () => getMeta(type, config.language || 'en-US', id, config, userUUID, false),
    undefined,
    { enableErrorCaching: true, maxRetries: 2, config },
    type,
    false
  ).catch(() => null);
  if (!result?.meta) return null;
  const { videos, ...meta } = result.meta;
  return { ...meta, _addedAt: Number(row.updated_at) || 0 };
}

const releasedAt = (meta: any): number => Date.parse(meta.released || '') || Date.parse(`${String(meta.releaseInfo || meta.year || '').slice(0, 4)}-01-01`) || 0;
const ratingOf = (meta: any): number => parseFloat(meta.imdbRating) || 0;

const ORDER: Record<Sort, (a: any, b: any) => number> = {
  added: (a, b) => b._addedAt - a._addedAt,
  released: (a, b) => releasedAt(b) - releasedAt(a),
  title: (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }),
  imdbrating: (a, b) => ratingOf(b) - ratingOf(a),
};

export async function getServerWatchlistCatalog(catalogId: string, type: string, page: number, config: any, userUUID: string): Promise<any[]> {
  const mediaType = serverWatchlistMediaType(catalogId);
  if (!mediaType || !userUUID) return [];

  const database: any = require('./database');
  const { viewerProfile } = require('./jellyfin/viewer');
  const rows: any[] = (await database.listWatchlist(userUUID, viewerProfile()).catch(() => []))
    .filter((row: any) => Number(row.listed) && (mediaType === 'all' || row.media_type === mediaType))
    .sort((a: any, b: any) => (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0))
    .slice(0, envInt('SERVER_WATCHLIST_MAX_ITEMS', 500, 1));

  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
  const sort = sortOf(config, catalogId, type);
  const concurrency = envInt('SERVER_WATCHLIST_CONCURRENCY', 8, 1);
  const from = (Math.max(1, page) - 1) * pageSize;

  const strip = ({ _addedAt, ...meta }: any) => meta;
  if (sort === 'added') {
    const metas = await mapWithConcurrency(rows.slice(from, from + pageSize), concurrency, (row: any) => titleMeta(config, userUUID, row));
    return metas.filter(Boolean).map(strip);
  }
  const metas = (await mapWithConcurrency(rows, concurrency, (row: any) => titleMeta(config, userUUID, row))).filter(Boolean);
  return metas.sort(ORDER[sort]).slice(from, from + pageSize).map(strip);
}
