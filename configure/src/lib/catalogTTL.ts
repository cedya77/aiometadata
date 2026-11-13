// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * A catalog's `cacheTTL` is an override, not a copy of the instance default. It is
 * stored only when someone picks a value; left absent, the catalog follows whatever
 * CATALOG_TTL the instance is currently on, so changing that default reaches every
 * catalog that never opted out.
 */

export function resolveCatalogTTL(value: number | null, min: number): number | undefined {
  return value === null ? undefined : Math.max(value, min);
}

export function formatTTL(seconds: number): string {
  if (seconds === 0) return 'no cache';
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

/**
 * The shortest TTL a catalog's source tolerates. The gear dialogs and the bulk
 * editor both floor against this, so a bulk edit can never push one catalog below
 * a limit its own dialog enforces.
 */
let simklListMinTTL = 300;

export function setSimklListMinTTL(seconds: number): void {
  if (Number.isFinite(seconds) && seconds > 0) simklListMinTTL = seconds;
}

export function minCacheTTLFor(catalogId: string, metadata?: { listType?: string }): number {
  if (catalogId === 'mdblist.upnext' || catalogId.startsWith('mdblist.watchlist') || catalogId.startsWith('custom.')) return 0;
  if (catalogId.startsWith('simkl.list.')) return simklListMinTTL;
  if (catalogId.startsWith('simkl.trending.')) return 3600;
  if (catalogId.startsWith('letterboxd.')) return 7200;
  if (catalogId === 'publicmetadb.upnext') return 900;
  if (catalogId.startsWith('publicmetadb.list.') && metadata?.listType === 'watchlist') return 900;
  if (catalogId.startsWith('publicmetadb.')) return 10800;
  return 300;
}

/**
 * Catalogs whose cache lifetime is not the user's to set: MDBList's discover
 * endpoint is server-cached for 6 hours, and TheTVDB lists always follow the
 * instance default. Writing a TTL onto either only leaves a field nothing reads.
 */
export function hasEditableCacheTTL(catalogId: string): boolean {
  return !catalogId.startsWith('mdblist.discover.') && !catalogId.startsWith('tvdb.list.');
}
