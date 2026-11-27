// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * URL Parser Utility for Quick Add Catalog feature
 * Detects service type from pasted URLs and extracts relevant identifiers
 */

export interface ParsedUrl {
  service: 'mdblist' | 'trakt' | 'letterboxd' | 'tvdb' | 'tmdb' | 'publicmetadb' | 'manifest' | 'unknown';
  type: 'single-list' | 'user-profile' | 'watchlist' | 'manifest';
  username?: string;
  listSlug?: string;
  externalListId?: string;
  /** MDBList official list: listSlug holds its slug; absent on the index of all official lists. */
  mdblistOfficial?: { mediatype?: 'movie' | 'show' };
  url: string;
}

/**
 * URL patterns for each supported service
 * Each pattern handles variations: http/https, www prefix, trailing slashes
 */
const URL_PATTERNS = {
  mdblist: {
    externalList: /^https?:\/\/(?:www\.)?mdblist\.com\/lists\/([^\/]+)\/external\/(\d+)\/?$/,
    // https://mdblist.com/lists/official, https://mdblist.com/lists/official/{movies|shows}/{slug}
    officialList: /^https?:\/\/(?:www\.)?mdblist\.com\/lists\/official(?:\/(?:(movies|shows)\/)?([^\/]+))?\/?$/,
    // https://mdblist.com/lists/{username}/{list-name}
    singleList: /^https?:\/\/(?:www\.)?mdblist\.com\/lists\/([^\/]+)\/([^\/]+)\/?$/,
    // https://mdblist.com/lists/{username}/ or https://mdblist.com/users/{username}/
    userProfile: /^https?:\/\/(?:www\.)?mdblist\.com\/(?:lists|users)\/([^\/]+)\/?$/,
  },
  trakt: {
    // https://trakt.tv/users/{username}/lists/{list-slug}
    singleList: /^https?:\/\/(?:www\.)?trakt\.tv\/users\/([^\/]+)\/lists\/([^\/]+)\/?$/,
    // https://trakt.tv/users/{username}/lists or https://trakt.tv/users/{username}
    userProfile: /^https?:\/\/(?:www\.)?trakt\.tv\/users\/([^\/]+)(?:\/lists)?\/?$/,
  },
  letterboxd: {
    // https://letterboxd.com/{username}/list/{list-name}
    singleList: /^https?:\/\/(?:www\.)?letterboxd\.com\/([^\/]+)\/list\/([^\/]+)\/?$/,
    // https://letterboxd.com/{username}/watchlist
    watchlist: /^https?:\/\/(?:www\.)?letterboxd\.com\/([^\/]+)\/watchlist\/?$/,
  },
  tvdb: {
    // https://thetvdb.com/lists/{slug}
    singleList: /^https?:\/\/(?:www\.)?thetvdb\.com\/lists\/([^\/]+)\/?$/,
  },
  publicmetadb: {
    // https://publicmetadb.com/lists/u/{username}/{list-slug}
    singleList: /^https?:\/\/(?:www\.)?publicmetadb\.com\/lists\/u\/([^\/]+)\/([^\/]+)\/?$/,
  },
  tmdb: {
    // https://www.themoviedb.org/collection/{id}-{slug}
    collection: /^https?:\/\/(?:www\.)?themoviedb\.org\/collection\/(\d+)(?:-[^\/]*)?\/?$/,
  },
  manifest: {
    // Any URL ending with /manifest.json
    any: /^https?:\/\/.+\/manifest\.json$/,
  },
};

function stripQueryParams(url: string): string {
  return url.split('?')[0];
}

export function parseMdblistExternalListUrl(url: string): { username: string; listId: string } | null {
  const match = stripQueryParams(url.trim()).match(URL_PATTERNS.mdblist.externalList);
  return match ? { username: match[1], listId: match[2] } : null;
}

export function parseMdblistOfficialListUrl(url: string): { slug?: string; mediatype?: 'movie' | 'show' } | null {
  const match = stripQueryParams(url.trim()).match(URL_PATTERNS.mdblist.officialList);
  if (!match) return null;
  const mediatype = match[1] === 'movies' ? 'movie' : match[1] === 'shows' ? 'show' : undefined;
  return { slug: match[2], mediatype };
}

/**
 * Parses a URL and returns structured data about the detected service
 */
export function parseQuickAddUrl(url: string): ParsedUrl {
  const trimmedUrl = url.trim();
  
  if (!trimmedUrl) {
    return { service: 'unknown', type: 'single-list', url: trimmedUrl };
  }

  const mdblistExternal = parseMdblistExternalListUrl(trimmedUrl);
  if (mdblistExternal) {
    return {
      service: 'mdblist',
      type: 'single-list',
      username: mdblistExternal.username,
      externalListId: mdblistExternal.listId,
      url: trimmedUrl,
    };
  }

  const mdblistOfficial = parseMdblistOfficialListUrl(trimmedUrl);
  if (mdblistOfficial) {
    return {
      service: 'mdblist',
      type: mdblistOfficial.slug ? 'single-list' : 'user-profile',
      username: 'official',
      listSlug: mdblistOfficial.slug,
      mdblistOfficial: { mediatype: mdblistOfficial.mediatype },
      url: trimmedUrl,
    };
  }

  // Check MDBList patterns
  const mdblistSingleMatch = trimmedUrl.match(URL_PATTERNS.mdblist.singleList);
  if (mdblistSingleMatch) {
    return {
      service: 'mdblist',
      type: 'single-list',
      username: mdblistSingleMatch[1],
      listSlug: mdblistSingleMatch[2],
      url: trimmedUrl,
    };
  }

  const mdblistUserMatch = trimmedUrl.match(URL_PATTERNS.mdblist.userProfile);
  if (mdblistUserMatch) {
    return {
      service: 'mdblist',
      type: 'user-profile',
      username: mdblistUserMatch[1],
      url: trimmedUrl,
    };
  }

  // Check Trakt patterns - strip query params like ?sort=rank,asc
  const cleanTraktUrl = stripQueryParams(trimmedUrl);
  
  const traktSingleMatch = cleanTraktUrl.match(URL_PATTERNS.trakt.singleList);
  if (traktSingleMatch) {
    return {
      service: 'trakt',
      type: 'single-list',
      username: traktSingleMatch[1],
      listSlug: traktSingleMatch[2],
      url: cleanTraktUrl,
    };
  }

  const traktUserMatch = cleanTraktUrl.match(URL_PATTERNS.trakt.userProfile);
  if (traktUserMatch) {
    return {
      service: 'trakt',
      type: 'user-profile',
      username: traktUserMatch[1],
      url: cleanTraktUrl,
    };
  }

  // Check Letterboxd patterns
  const letterboxdSingleMatch = trimmedUrl.match(URL_PATTERNS.letterboxd.singleList);
  if (letterboxdSingleMatch) {
    return {
      service: 'letterboxd',
      type: 'single-list',
      username: letterboxdSingleMatch[1],
      listSlug: letterboxdSingleMatch[2],
      url: trimmedUrl,
    };
  }

  const letterboxdWatchlistMatch = trimmedUrl.match(URL_PATTERNS.letterboxd.watchlist);
  if (letterboxdWatchlistMatch) {
    return {
      service: 'letterboxd',
      type: 'watchlist',
      username: letterboxdWatchlistMatch[1],
      url: trimmedUrl,
    };
  }

  // Check TheTVDB pattern - strip query params like ?tab=lists
  const tvdbSingleMatch = stripQueryParams(trimmedUrl).match(URL_PATTERNS.tvdb.singleList);
  if (tvdbSingleMatch) {
    return {
      service: 'tvdb',
      type: 'single-list',
      listSlug: decodeURIComponent(tvdbSingleMatch[1]),
      url: stripQueryParams(trimmedUrl),
    };
  }

  const publicmetadbMatch = stripQueryParams(trimmedUrl).match(URL_PATTERNS.publicmetadb.singleList);
  if (publicmetadbMatch) {
    return {
      service: 'publicmetadb',
      type: 'single-list',
      username: decodeURIComponent(publicmetadbMatch[1]),
      listSlug: decodeURIComponent(publicmetadbMatch[2]),
      url: stripQueryParams(trimmedUrl),
    };
  }

  // Check TMDB collection pattern - strip query params like ?language=en
  const tmdbCollectionMatch = stripQueryParams(trimmedUrl).match(URL_PATTERNS.tmdb.collection);
  if (tmdbCollectionMatch) {
    return {
      service: 'tmdb',
      type: 'single-list',
      listSlug: tmdbCollectionMatch[1],
      url: stripQueryParams(trimmedUrl),
    };
  }

  // Check manifest pattern
  if (URL_PATTERNS.manifest.any.test(trimmedUrl)) {
    return {
      service: 'manifest',
      type: 'manifest',
      url: trimmedUrl,
    };
  }

  // Unknown URL format
  return { service: 'unknown', type: 'single-list', url: trimmedUrl };
}
