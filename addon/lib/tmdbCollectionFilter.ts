import * as moviedb from './getTmdb.js';
import type { UserConfig } from '../types/index.js';

interface TmdbDiscoverResponse {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: any[];
  [key: string]: any;
}

function parseCollectionIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[|,]/);
  return Array.from(new Set(values
    .map(item => Number(String(item).trim()))
    .filter(id => Number.isInteger(id) && id > 0)));
}

async function collectionMovieIds(collectionIds: number[], language: string, config: UserConfig): Promise<Set<string>> {
  const collections = await Promise.all(collectionIds.map(id =>
    moviedb.collectionInfo({ id, language }, config).catch(() => null)
  ));
  const ids = new Set<string>();
  for (const collection of collections) {
    for (const part of Array.isArray(collection?.parts) ? collection.parts : []) {
      if (part?.id) ids.add(String(part.id));
    }
  }
  return ids;
}

export async function fetchTmdbDiscoverWithCollections(
  mediaType: 'movie' | 'tv',
  params: Record<string, any>,
  page: number,
  language: string,
  config: UserConfig,
  fetchPage: (params: Record<string, any>) => Promise<TmdbDiscoverResponse>
): Promise<TmdbDiscoverResponse> {
  const collectionIds = parseCollectionIds(params.collection_ids);
  const requestParams = { ...params };
  delete requestParams.collection_ids;
  if (collectionIds.length === 0) {
    return fetchPage({ ...requestParams, page });
  }

  if (mediaType !== 'movie') return { page, total_pages: 0, total_results: 0, results: [] };

  const allowedIds = await collectionMovieIds(collectionIds, language, config);
  if (allowedIds.size === 0) return { page, total_pages: 0, total_results: 0, results: [] };

  const pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20', 10) || 20;
  const desiredEnd = Math.max(1, page) * pageSize;
  const maxPages = Math.max(
    Math.max(1, page),
    parseInt(process.env.CATALOG_FILTER_FILL_MAX_PAGES || '5', 10) || 5
  );
  const matching: any[] = [];
  let lastResponse: TmdbDiscoverResponse = { page: 1, results: [] };

  for (let candidatePage = 1; candidatePage <= maxPages; candidatePage += 1) {
    lastResponse = await fetchPage({ ...requestParams, page: candidatePage });
    const results = Array.isArray(lastResponse.results) ? lastResponse.results : [];
    matching.push(...results.filter(item => allowedIds.has(String(item?.id))));
    if (matching.length >= desiredEnd || results.length === 0 || candidatePage >= Number(lastResponse.total_pages || maxPages)) break;
  }

  const start = (Math.max(1, page) - 1) * pageSize;
  return {
    ...lastResponse,
    page,
    total_results: matching.length,
    total_pages: Math.ceil(matching.length / pageSize),
    results: matching.slice(start, start + pageSize),
  };
}

export const __privateTmdbCollectionFilter = { parseCollectionIds, collectionMovieIds };
