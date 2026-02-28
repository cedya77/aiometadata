/**
 * Shared Catalog Creation Utilities for Quick Add and Integration components
 * Provides reusable functions for creating catalog configurations from various services
 */

import { CatalogConfig } from '@/contexts/ConfigContext';
import { GenreSelection } from '@/data/genres';

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

  // Construct list URL if not provided but we have username/list info
  let finalListUrl = listUrl;
  if (!finalListUrl && list.user_name && list.name) {
    // Construct URL from username and list name/slug
    const username = list.user_name.toLowerCase().replace(/\s+/g, '');
    const listSlug = list.slug || list.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    finalListUrl = `https://mdblist.com/lists/${username}/${listSlug}`;
  }

  return {
    id: `mdblist.${list.id}`,
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
      ...(list.user_name ? { author: list.user_name } : {}),
      ...(finalListUrl && { url: finalListUrl }),
      ...(list.mediatype && { mediatype: list.mediatype }),
    },
  };
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
