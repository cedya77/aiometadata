// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE

export const MOVIELENS_WATCHLIST_ID = 'movielens.watchlist';
export const MOVIELENS_LIST_PREFIX = 'movielens.list.';

/**
 * Explore-API catalogs. New ids start with `movielens.explore`, but configs may
 * still hold older ids (`movielens.toppicks`, `movielens.toppicks.<name>.<suffix>`, ...),
 * so every MovieLens id that is not the watchlist or a list counts as explore.
 */
export function isMovieLensExploreId(catalogId: string): boolean {
  return typeof catalogId === 'string'
    && catalogId.startsWith('movielens.')
    && catalogId !== MOVIELENS_WATCHLIST_ID
    && !catalogId.startsWith(MOVIELENS_LIST_PREFIX);
}
