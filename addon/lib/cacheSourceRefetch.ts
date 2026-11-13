// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Refresh-ahead rebuilds a catalog page by re-running the same build the request
 * path runs, so a source list that is still cached is read back rather than
 * fetched, and the rebuilt page is written with a full TTL over data that never
 * left the cache. This marks the rebuild so the source fetch goes upstream.
 *
 * Only caches that opt in with `sourceList: true` honour it. Per-title lookups
 * (TMDB, fanart, IMDb) must not: a rebuild touches every item on the page, and
 * bypassing those would turn one refresh into hundreds of upstream calls.
 */

const store = new AsyncLocalStorage<{ refetch: boolean }>();

function runWithSourceRefetch<T>(fn: () => T): T {
  return store.run({ refetch: true }, fn);
}

function sourceRefetchRequested(): boolean {
  return store.getStore()?.refetch === true;
}

export { runWithSourceRefetch, sourceRefetchRequested };
module.exports = { runWithSourceRefetch, sourceRefetchRequested };
