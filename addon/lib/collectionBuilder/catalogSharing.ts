// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * What may leave a config when a catalog is shared. Used by the catalog export in
 * the configure UI and by the collection exports, which embed catalogs so an
 * imported layout can rebuild them. Structural types: the frontend's CatalogConfig
 * is not reachable from the addon.
 */

export interface ShareableCatalog {
  id: string;
  name: string;
  type: string;
  source: string;
  enabled?: boolean;
  showInHome?: boolean;
  displayType?: string;
  cacheTTL?: number;
  sort?: string;
  sortDirection?: string;
  metadata?: Record<string, any>;
  [key: string]: any;
}

const USER_SPECIFIC_PATTERNS = [
  'tmdb.watchlist',
  'tmdb.favorites',
  'tmdb.list.',
  'trakt.watchlist',
  'trakt.favorites',
  'trakt.recommendations',
  'trakt.calendar',
  'trakt.list.',
  'trakt.upnext',
  'trakt.unwatched',
  'trakt.history',
  'simkl.watchlist',
  'simkl.upnext',
  'simkl.watching',
  'simkl.plantowatch',
  'simkl.completed',
  'simkl.dropped',
  'simkl.hold',
  'anilist.watching',
  'anilist.planning',
  'anilist.completed',
  'anilist.dropped',
  'anilist.paused',
  'anilist.repeating',
  'stremthru.',
  'recommendations.',
  'movielens.',
  'aiom.watchlist.',
];

export function isUserSpecific(catalogId: string): boolean {
  return USER_SPECIFIC_PATTERNS.some(pattern => catalogId.startsWith(pattern));
}

/**
 * A PublicMetaDB list is only fetchable by another key when it is public, and a
 * watchlist is the owner's either way. Absent metadata means the catalog predates
 * us recording it, so it is treated as personal rather than shared blindly.
 */
function isPersonalPublicMetaDBList(catalog: ShareableCatalog): boolean {
  if (!catalog.id.startsWith('publicmetadb.list.')) return false;
  if (catalog.metadata?.listType === 'watchlist') return true;
  return catalog.metadata?.isPublic !== true;
}

export function isPrivateList(catalog: ShareableCatalog): boolean {
  if (catalog.metadata?.privacy === 'private') return true;
  if (catalog.source === 'letterboxd' && catalog.metadata?.isWatchlist) return true;
  return isPersonalPublicMetaDBList(catalog);
}

const SAFE_METADATA = [
  'discover', 'discoverParams', 'interval', 'pageSize', 'useShowPosterForUpNext',
  'airingSoonDays', 'status', 'description', 'itemCount', 'url', 'identifier',
  'isWatchlist', 'isCustomList', 'mediatype', 'username', 'listName', 'author',
  'listId', 'listDescription', 'isPublic', 'listType',
  'mergeMode', 'mergedSources',
];

/** Everything not named here is dropped, `privacy` deliberately among them. */
export function sanitizeMetadata(
  metadata: Record<string, any> | undefined,
  keepSource: (entry: any) => boolean = (entry) => !isUserSpecific(String(entry.catalogId))
): Record<string, any> | undefined {
  if (!metadata) return undefined;

  const safe: Record<string, any> = {};
  for (const key of SAFE_METADATA) {
    const value = metadata[key];
    if (value !== undefined) safe[key] = value;
  }

  if (Array.isArray(safe.mergedSources)) {
    // originalEnabled and originalShowInHome describe the author's config before the
    // merge, which means nothing to anyone importing it.
    safe.mergedSources = safe.mergedSources
      .filter((entry: any) => entry?.catalogId && keepSource(entry))
      .map((entry: any) => ({ catalogId: entry.catalogId, catalogType: entry.catalogType }));
    if (safe.mergedSources.length === 0) delete safe.mergedSources;
  }

  return Object.keys(safe).length > 0 ? safe : undefined;
}

/** One catalog stripped of anything private, or null when the catalog is personal. */
export function buildShareableCatalog<T extends ShareableCatalog>(catalog: T): T | null {
  if (isUserSpecific(catalog.id) || isPrivateList(catalog)) return null;

  const shared: Record<string, any> = { ...catalog };
  const metadata = sanitizeMetadata(catalog.metadata);
  if (metadata) shared.metadata = metadata;
  else delete shared.metadata;

  return shared as T;
}
