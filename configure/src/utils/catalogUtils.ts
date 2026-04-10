/**
 * Shared Catalog Creation Utilities for Quick Add and Integration components
 * Provides reusable functions for creating catalog configurations from various services
 */

import { CatalogConfig } from '@/contexts/ConfigContext';
import { GenreSelection } from '@/data/genres';

const MDBLIST_LIST_URL_PATTERN = /^https?:\/\/(?:www\.)?mdblist\.com\/lists\/([^\/?#]+)\/([^\/?#]+)\/?$/i;

/**
 * Determines the catalog type based on MDBList list metadata
 * @param list - MDBList list object with mediatype, movies, shows, items properties
 * @returns 'movie' | 'series' | 'all' based on list content
 */
export function getMdbListType(list: any): 'movie' | 'series' | 'all' {
  if (list.mediatype) {
    if (list.mediatype === 'movie') return 'movie';
    if (list.mediatype === 'show') return 'series';
  }

  const movies = list.movies ?? (list.items - (list.shows ?? list.items_show ?? 0));
  const shows = list.shows ?? list.items_show ?? 0;

  if (movies > 0 && shows > 0) {
    return 'all';
  }
  if (movies > 0) {
    return 'movie';
  }
  if (shows > 0) {
    return 'series';
  }
  
  if (list.mediatype && typeof list.mediatype === 'string') {
    return list.mediatype === 'movie' ? 'movie' : 'series';
  }
  return 'all';
}

function normalizeMDBListUsername(value?: string): string | undefined {
  if (!value || typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase().replace(/\s+/g, '');
  return normalized || undefined;
}

function slugifyMDBListListName(value?: string): string | undefined {
  if (!value || typeof value !== 'string') return undefined;

  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  return slug || undefined;
}

export function parseMDBListCatalogUrl(listUrl?: string): { username: string; listSlug: string } | null {
  if (!listUrl) return null;

  const match = listUrl.trim().match(MDBLIST_LIST_URL_PATTERN);
  if (!match) return null;

  return {
    username: normalizeMDBListUsername(decodeURIComponent(match[1])) || match[1],
    listSlug: decodeURIComponent(match[2]),
  };
}

export function getMDBListCatalogIdentity(list: any, listUrl?: string): { username?: string; listSlug?: string } {
  const parsedUrl = parseMDBListCatalogUrl(listUrl);
  const username =
    parsedUrl?.username ||
    normalizeMDBListUsername(list.user_name) ||
    normalizeMDBListUsername(list.user);
  const listSlug =
    parsedUrl?.listSlug ||
    (typeof list.slug === 'string' && list.slug.trim() ? list.slug.trim() : undefined) ||
    slugifyMDBListListName(list.name);

  return {
    username,
    listSlug,
  };
}

export function buildSyntheticMDBListUnifiedCatalogId(username: string, listSlug: string): string {
  return `mdblist.${normalizeMDBListUsername(username) || username}.${listSlug}.unified`;
}

export function getMDBListCatalogId(list: any, sourceUrl?: string, listUrl?: string): string {
  const type = getMdbListType(list);
  const { username, listSlug } = getMDBListCatalogIdentity(list, listUrl);
  const isExternalList = !!sourceUrl && sourceUrl.includes('/external/lists/');

  if (type === 'all' && !isExternalList && username && listSlug) {
    return buildSyntheticMDBListUnifiedCatalogId(username, listSlug);
  }

  return `mdblist.${list.id}`;
}

function getMDBListGroupingIdentity(list: any): string {
  const { username, listSlug } = getMDBListCatalogIdentity(list);

  if (username && listSlug) {
    return `${username}:${listSlug}`;
  }

  if (list.slug) {
    return String(list.slug);
  }

  return `${list.user_name || list.user || 'unknown'}:${list.name || list.id}`;
}

/**
 * MDBList exposes some mixed dynamic lists as two sibling list metadata entries
 * (one movie, one show) that share the same public username/slug. We collapse
 * those pairs into a single synthetic mixed definition for import flows so the
 * catalog can later resolve through the unified items endpoint.
 */
export function groupMDBListListsForImport(lists: any[]): any[] {
  const grouped = new Map<string, any[]>();

  lists.forEach((list: any) => {
    const key = getMDBListGroupingIdentity(list);
    const entries = grouped.get(key);
    if (entries) {
      entries.push(list);
    } else {
      grouped.set(key, [list]);
    }
  });

  return Array.from(grouped.values()).map((entries) => {
    if (entries.length === 1) {
      return entries[0];
    }

    const hasMovie = entries.some(entry => entry.mediatype === 'movie');
    const hasShow = entries.some(entry => entry.mediatype === 'show');

    if (!hasMovie || !hasShow) {
      return entries[0];
    }

    const first = entries[0];
    const totals = entries.reduce((acc, entry) => {
      const itemCount = Number(entry.items ?? 0);
      if (entry.mediatype === 'movie') {
        acc.movies += Number(entry.movies ?? itemCount);
      } else if (entry.mediatype === 'show') {
        acc.shows += Number(entry.shows ?? entry.items_show ?? itemCount);
      }
      acc.items += itemCount;
      return acc;
    }, { items: 0, movies: 0, shows: 0 });

    return {
      ...first,
      id: `unified:${getMDBListGroupingIdentity(first)}`,
      mediatype: undefined,
      items: totals.items,
      movies: totals.movies,
      shows: totals.shows,
      items_show: totals.shows,
      _groupedEntries: entries,
    };
  });
}

/**
 * Gets the display type override based on catalog type and user preferences
 */
function getDisplayTypeOverride(
  catalogType: 'movie' | 'series' | 'anime' | 'all',
  overrides?: { movie?: string; series?: string }
): string | undefined {
  if (!overrides) return undefined;
  if (catalogType === 'movie' && overrides.movie) return overrides.movie;
  if (catalogType === 'series' && overrides.series) return overrides.series;
  return undefined;
}

// ============================================================================
// MDBList Catalog Creation
// ============================================================================

export interface MDBListCatalogOptions {
  list: any;
  sort?: CatalogConfig['sort'];
  order?: 'asc' | 'desc';
  cacheTTL?: number;
  genreSelection?: GenreSelection;
  displayTypeOverrides?: { movie?: string; series?: string };
  sourceUrl?: string;
  listUrl?: string; // URL to the list on mdblist.com
}

export interface MDBListCatalogImportOptions extends MDBListCatalogOptions {
  unified?: boolean;
}

/**
 * Creates an MDBList catalog configuration
 * @param options - Configuration options for the MDBList catalog
 * @returns CatalogConfig object ready to be added to the config
 */
export function createMDBListCatalog(options: MDBListCatalogOptions): CatalogConfig {
  const {
    list,
    sort = 'default',
    order = 'asc',
    cacheTTL = 86400, // Default 24 hours
    genreSelection = 'standard',
    displayTypeOverrides,
    sourceUrl,
    listUrl,
  } = options;

  const type = getMdbListType(list);
  const displayType = getDisplayTypeOverride(type, displayTypeOverrides);
  const identity = getMDBListCatalogIdentity(list, listUrl);
  const catalogId = getMDBListCatalogId(list, sourceUrl, listUrl);

  // Construct list URL if not provided but we have username/list info
  let finalListUrl = listUrl;
  if (!finalListUrl && identity.username && identity.listSlug) {
    finalListUrl = `https://mdblist.com/lists/${identity.username}/${identity.listSlug}`;
  }

  return {
    id: catalogId,
    type,
    name: list.name,
    enabled: true,
    showInHome: true,
    source: 'mdblist',
    sort,
    order,
    cacheTTL,
    genreSelection,
    enableRatingPosters: true,
    ...(displayType && { displayType }),
    ...(sourceUrl && { sourceUrl }),
    metadata: {
      ...(list.items !== undefined && { itemCount: list.items }),
      ...(list.user_name || identity.username ? { author: list.user_name || identity.username } : {}),
      ...(finalListUrl && { url: finalListUrl }),
      ...(identity.username && { username: identity.username }),
      ...(identity.listSlug && { listSlug: identity.listSlug }),
      ...(list.mediatype && { mediatype: list.mediatype }),
      ...(type === 'all' && identity.username && identity.listSlug ? { unified: true } : {}),
    },
  };
}

export function createMDBListCatalogsForImport(options: MDBListCatalogImportOptions): CatalogConfig[] {
  const { list, unified = true } = options;
  const listType = getMdbListType(list);

  if (listType !== 'all' || unified) {
    return [createMDBListCatalog(options)];
  }

  const groupedEntries = Array.isArray(list?._groupedEntries) ? list._groupedEntries : [];
  const splitEntries = groupedEntries.filter((entry: any) => entry?.mediatype === 'movie' || entry?.mediatype === 'show');

  if (splitEntries.length > 0) {
    return splitEntries.map((entry: any) => createMDBListCatalog({
      ...options,
      list: entry,
    }));
  }

  const movieCatalog = createMDBListCatalog({
    ...options,
    list: {
      ...list,
      id: `${list.id}.movies`,
      name: `${list.name} (Movies)`,
      mediatype: 'movie',
      items: Number(list.movies ?? 0),
      movies: Number(list.movies ?? 0),
      shows: 0,
      items_show: 0,
    },
  });

  const seriesCatalog = createMDBListCatalog({
    ...options,
    list: {
      ...list,
      id: `${list.id}.series`,
      name: `${list.name} (Series)`,
      mediatype: 'show',
      items: Number(list.shows ?? list.items_show ?? 0),
      movies: 0,
      shows: Number(list.shows ?? list.items_show ?? 0),
      items_show: Number(list.shows ?? list.items_show ?? 0),
    },
  });

  return [movieCatalog, seriesCatalog];
}

// ============================================================================
// Trakt Catalog Creation
// ============================================================================

export interface TraktCatalogOptions {
  list: any;
  username?: string;
  sort?: string;
  sortDirection?: 'asc' | 'desc';
  displayTypeOverrides?: { movie?: string; series?: string };
  catalogType?: 'all' | 'movie' | 'series';
}

/**
 * Creates a Trakt catalog configuration
 * @param options - Configuration options for the Trakt catalog
 * @returns CatalogConfig object ready to be added to the config
 */
export function createTraktCatalog(options: TraktCatalogOptions): CatalogConfig {
  const {
    list,
    username,
    sort = 'default',
    sortDirection = 'asc',
    displayTypeOverrides,
    catalogType = 'all',
  } = options;

  const displayType = getDisplayTypeOverride(catalogType, displayTypeOverrides);
  const numericListId = list?.ids?.trakt;
  const catalogId = numericListId ? `trakt.list.${numericListId}` : `trakt.${username}.${list.ids?.slug || list.slug}`;

  // Construct Trakt list URL - prefer numeric ID format, fallback to username/slug
  let listUrl: string | undefined;
  if (numericListId) {
    // Use numeric ID format: https://trakt.tv/lists/{id}
    listUrl = `https://trakt.tv/lists/${numericListId}`;
  } else {
    // Fallback to username/slug format
    const listUsername = list.user?.username || username;
    const listSlug = list.ids?.slug || list.slug;
    if (listUsername && listSlug) {
      listUrl = `https://trakt.tv/users/${listUsername}/lists/${listSlug}`;
    }
  }

  return {
    id: catalogId,
    type: catalogType,
    name: list.name,
    enabled: true,
    showInHome: true,
    source: 'trakt',
    sort: (sort === 'default' ? (list.sort_by || 'default') : sort) as any,
    sortDirection: sort === 'default' ? (list.sort_how === 'desc' ? 'desc' : 'asc') : sortDirection,
    ...(displayType && { displayType }),
    metadata: {
      itemCount: list.item_count || 0,
      privacy: list.privacy || 'private',
      author: list.user?.username || username || '',
      description: list.description || '',
      ...(listUrl && { url: listUrl }),
    },
  };
}

// ============================================================================
// Letterboxd Catalog Creation
// ============================================================================

export interface LetterboxdCatalogOptions {
  identifier: string;
  title: string;
  itemCount?: number;
  isWatchlist: boolean;
  url: string;
  cacheTTL?: number;
  displayTypeOverrides?: { movie?: string; series?: string };
}

/**
 * Creates a Letterboxd catalog configuration
 * @param options - Configuration options for the Letterboxd catalog
 * @returns CatalogConfig object ready to be added to the config
 */
export function createLetterboxdCatalog(options: LetterboxdCatalogOptions): CatalogConfig {
  const {
    identifier,
    title,
    itemCount = 0,
    isWatchlist,
    url,
    cacheTTL = 86400, // Default 24 hours
    displayTypeOverrides,
  } = options;

  const displayType = getDisplayTypeOverride('movie', displayTypeOverrides);

  return {
    id: `letterboxd.${identifier}`,
    type: 'movie', // Letterboxd is primarily movies
    name: title,
    enabled: true,
    showInHome: true,
    source: 'letterboxd',
    cacheTTL,
    enableRatingPosters: true,
    ...(displayType && { displayType }),
    metadata: {
      itemCount,
      isWatchlist,
      identifier,
      url,
    },
  };
}

// ============================================================================
// Custom Manifest Catalog Creation
// ============================================================================

export interface CustomManifestCatalogOptions {
  manifest: {
    id: string;
    name: string;
    idPrefixes?: string[];
  };
  catalog: {
    type: string;
    id: string;
    name: string;
    genres?: string[];
    extra?: any[];
  };
  manifestUrl: string;
  cacheTTL?: number;
  pageSize?: number;
  displayTypeOverrides?: { movie?: string; series?: string };
}

/**
 * Creates a Custom Manifest catalog configuration
 * @param options - Configuration options for the Custom Manifest catalog
 * @returns CatalogConfig object ready to be added to the config
 */
export function createCustomManifestCatalog(options: CustomManifestCatalogOptions): CatalogConfig {
  const {
    manifest,
    catalog,
    manifestUrl,
    cacheTTL = 86400, // Default 24 hours
    pageSize = 100,
    displayTypeOverrides,
  } = options;

  const catalogType = catalog.type as 'movie' | 'series' | 'anime';
  const displayType = getDisplayTypeOverride(catalogType, displayTypeOverrides);
  
  // Generate unique catalog ID
  const manifestId = manifest.id.replace(/[^a-zA-Z0-9]/g, '_');
  const uniqueCatalogId = `custom.${manifestId}.${catalog.type}.${catalog.id.replace(/[^a-zA-Z0-9]/g, '_')}`;
  
  // Construct the full catalog URL with proper encoding
  const encodedCatalogId = encodeURIComponent(catalog.id);
  const catalogUrl = `${manifestUrl.replace('/manifest.json', '')}/catalog/${catalog.type}/${encodedCatalogId}.json`;

  return {
    id: uniqueCatalogId,
    type: catalogType,
    name: catalog.name,
    enabled: true,
    showInHome: true,
    source: 'custom',
    sourceUrl: catalogUrl,
    genres: catalog.genres || [],
    cacheTTL,
    pageSize,
    enableRatingPosters: true,
    manifestData: {
      ...catalog,
      idPrefixes: manifest.idPrefixes,
    },
    ...(displayType && { displayType }),
  };
}
