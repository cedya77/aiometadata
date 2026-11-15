// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { CatalogConfig } from '@/contexts/config';
import { apiCache } from '@/utils/apiCache';

export interface CuratorProfile {
  username: string;
  /** Matched verbatim by buildCuratorCatalogs, so decoration goes in `emoji`. */
  name: string;
  description: string;
  monogram: string;
  emoji?: string;
}

export const TRUSTED_CURATORS: CuratorProfile[] = [
  {
    username: 'danaramapyjama',
    name: 'Dan Pyjama',
    description: 'Films for pyjama wearers, by a pyjama wearer.',
    monogram: 'DP',
    emoji: '\u{1F6CC}',
  },
  {
    username: 'tvgeniekodi',
    name: 'Mr. Professor',
    description: 'Curated TV and movie lists.',
    monogram: 'MP',
  },
  {
    username: 'snoak',
    name: 'Snoak',
    description: 'Quality content collections.',
    monogram: 'SN',
  },
  {
    username: 'garycrawfordgc',
    name: 'Gary Crawford',
    description: 'Expert curated lists.',
    monogram: 'GC',
  },
];

export interface MDBListCollection {
  id: number | string;
  name: string;
  mediatype?: string;
  items?: number;
  user_name?: string;
  user?: string;
  private?: boolean;
}

export interface CuratorList extends MDBListCollection {
  curatorName: string;
  curatorUsername: string;
  selectionKey: string;
}

/** MDBList ignores unrecognised values rather than erroring, so these must match exactly. */
export type CuratorSort = 'ranked' | 'name' | 'created';

export class MDBListKeyRejected extends Error {
  constructor() {
    super('MDBList rejected that key.');
    this.name = 'MDBListKeyRejected';
  }
}

const CACHE_TTL_MS = 30 * 60 * 1000;

export async function fetchCuratorLists(
  curator: CuratorProfile,
  apiKey: string,
  sort: CuratorSort
): Promise<CuratorList[]> {
  // Cache key omits the API key, so private lists must be filtered out below.
  return apiCache.cachedFetch<CuratorList[]>(
    `setup_curator_lists_${curator.username}_${sort}`,
    async () => {
      const query = new URLSearchParams({ apikey: apiKey, username: curator.username, sort });
      const response = await fetch(`/api/mdblist/lists/user?${query.toString()}`);

      if (response.status === 401 || response.status === 403) throw new MDBListKeyRejected();
      if (!response.ok) throw new Error(`MDBList returned ${response.status}.`);

      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error('MDBList sent something unexpected.');

      return (payload as MDBListCollection[])
        .filter(list => !!list.id && !!list.name && list.private !== true)
        .map(list => ({
          ...list,
          curatorName: curator.name,
          curatorUsername: curator.username,
          selectionKey: `${curator.username}:${String(list.id)}`,
        }));
    },
    CACHE_TTL_MS
  );
}

export async function fetchListPosters(
  listId: string | number,
  apiKey: string,
  limit = 4
): Promise<string[]> {
  return apiCache.cachedFetch<string[]>(
    `setup_list_posters_${listId}_${limit}`,
    async () => {
      const query = new URLSearchParams({ apikey: apiKey, limit: String(limit) });
      const response = await fetch(`/api/mdblist/lists/${encodeURIComponent(String(listId))}/items?${query}`);
      if (!response.ok) return [];

      const payload = await response.json().catch(() => null);
      return ((payload?.items ?? []) as Array<{ poster?: string | null }>)
        .map(item => item.poster)
        .filter((poster): poster is string => !!poster)
        .slice(0, limit);
    },
    CACHE_TTL_MS
  );
}

export function buildCuratorCatalogs(lists: CuratorList[], catalogTTL: number): CatalogConfig[] {
  const seen = new Set<string>();
  const catalogs: CatalogConfig[] = [];

  for (const list of lists) {
    if (!list.id || !list.name) continue;

    const type: CatalogConfig['type'] = list.mediatype === 'movie' ? 'movie' : 'series';
    const catalogId = `mdblist.${list.id}`;
    if (seen.has(catalogId)) continue;
    seen.add(catalogId);

    const displayType = list.curatorName === 'Dan Pyjama' && type === 'movie' ? 'film' : undefined;
    const username = (list.user_name || list.user || list.curatorUsername || '')
      .toLowerCase()
      .replace(/\s+/g, '');
    const listSlug = String(list.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const listUrl = username && listSlug ? `https://mdblist.com/lists/${username}/${listSlug}` : undefined;
    const author = list.user_name || list.curatorName || list.user;

    catalogs.push({
      id: catalogId,
      type,
      name: String(list.name),
      enabled: true,
      showInHome: true,
      source: 'mdblist',
      sort: 'default',
      order: 'asc',
      genreSelection: 'standard',
      enableRatingPosters: true,
      ...(displayType ? { displayType } : {}),
      metadata: {
        privacy: list.private ? 'private' : 'public',
        ...(typeof list.items === 'number' ? { itemCount: list.items } : {}),
        ...(author ? { author } : {}),
        ...(listUrl ? { url: listUrl } : {}),
      },
    });
  }

  return catalogs;
}
