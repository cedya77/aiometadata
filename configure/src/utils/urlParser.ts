/**
 * URL Parser Utility for Quick Add Catalog feature
 * Detects service type from pasted URLs and extracts relevant identifiers
 */

export interface ParsedUrl {
  service: 'mdblist' | 'trakt' | 'letterboxd' | 'manifest' | 'unknown';
  type: 'single-list' | 'user-profile' | 'watchlist' | 'manifest';
  username?: string;
  listSlug?: string;
  url: string;
}

/**
 * URL patterns for each supported service
 * Each pattern handles variations: http/https, www prefix, trailing slashes
 */
const URL_PATTERNS = {
  mdblist: {
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
  manifest: {
    // Any URL ending with /manifest.json
    any: /^https?:\/\/.+\/manifest\.json$/,
  },
};

function stripQueryParams(url: string): string {
  return url.split('?')[0];
}

/**
 * Parses a URL and returns structured data about the detected service
 */
export function parseQuickAddUrl(url: string): ParsedUrl {
  const trimmedUrl = url.trim();
  
  if (!trimmedUrl) {
    return { service: 'unknown', type: 'single-list', url: trimmedUrl };
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
