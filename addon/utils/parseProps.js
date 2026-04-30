const { decompressFromEncodedURIComponent } = require('lz-string');
const axios = require('axios');
const fanart = require('./fanart');
const anilist = require('../lib/anilist');
const tvdb = require('../lib/tvdb');
const tmdb = require('../lib/getTmdb');
const imdb = require('../lib/imdb');
const kitsu = require('../lib/kitsu');
const jikan = require('../lib/mal');
const { resolveAllIds } = require('../lib/id-resolver');
const idMapper = require('../lib/id-mapper');
const { selectFanartImageByLang } = require('./fanart');
const { getImdbRating } = require('../lib/getImdbRating');
const consola = require('consola');
const { cacheWrapMetaSmart, cacheWrapGlobal } = require('../lib/getCache');
const { getReleaseAvailability } = require('./releaseAvailability');
const wikiMappings = require('../lib/wiki-mapper.js');
const CATALOG_TTL = parseInt(process.env.CATALOG_TTL || 1 * 24 * 60 * 60, 10);
const buildInfo = require('../lib/buildInfo');
// Dynamic import to avoid circular dependency

const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;


const logger = consola.withTag('ParseProps');

// Check if debug is enabled (CONSOLA_LEVEL >= 4)
const isDebugEnabled = consola.level >= 4;

/**
 * Helper function to check if RPDB is enabled for the current context
 * Checks per-catalog settings if available, otherwise defaults to true
 */
function isRatingPostersEnabled(config) {
  // Check catalog-level RatingPosters setting (for catalog routes)
  if (config._currentCatalogConfig) {
    return config._currentCatalogConfig.enableRatingPosters !== false;
  }
  
  // Check search catalog-level RatingPosters setting (for search routes)
  if (config._currentSearchCatalogId) {
    return config.search?.engineRatingPosters?.[config._currentSearchCatalogId] === true;
  }
  
  // Default to true if neither catalog nor search context is set
  return true;
}

/**
 * Helper function to check if poster rating is enabled (RPDB or Top Poster).
 * Always returns false — poster rating URLs are now applied as post-processing
 * via art URL patterns in the route handlers. This function is kept for backward
 * compatibility with internal callers that conditionally apply rating posters.
 */
function isPosterRatingEnabled(config) {
  return false;
}

/**
 * Resolve a custom art URL pattern by replacing placeholders with actual IDs.
 * Returns the resolved URL, or null if the pattern is empty or a referenced placeholder has no value.
 *
 * Composite placeholders for rating poster services:
 *   {rating_id_type} — resolves to 'imdb', 'tmdb', or 'tvdb' (first available)
 *   {rating_id}      — resolves to the matching ID in the format the service expects:
 *                       imdb: 'tt1234567', tmdb/tvdb: 'movie-12345' or 'series-12345'
 *
 * @param {string} pattern - URL pattern with placeholders
 * @param {object} ids - Object with id, tmdbId, imdbId, tvdbId, malId, kitsuId, anilistId, anidbId properties
 * @param {string} type - Content type (movie, series)
 * @param {object} [config] - User config (for API key and language placeholders)
 * @returns {string|null} Resolved URL or null
 */
function resolveCustomArtUrl(pattern, ids, type, config, extra) {
  if (!pattern || typeof pattern !== 'string' || !pattern.trim()) return null;

  // For RPDB/TOP patterns, try ID fallback: imdb → tmdb → tvdb
  const isRatingPosterService = pattern.includes('ratingposterdb.com') || pattern.includes('top-posters.com');
  if (isRatingPosterService) {
    return resolveRatingPosterUrl(pattern, ids, type, config, extra);
  }

  return resolvePattern(pattern, ids, type, config, extra);
}

/**
 * Core pattern resolution — replaces placeholders and returns the URL or null.
 */
function resolvePattern(pattern, ids, type, config, extra) {
  if (!pattern || typeof pattern !== 'string' || !pattern.trim()) return null;

  const lang = config?.language || 'en-US';
  const placeholders = {
    '{id}': ids?.id || '',
    '{tmdb_id}': ids?.tmdbId || '',
    '{imdb_id}': ids?.imdbId || '',
    '{tvdb_id}': ids?.tvdbId || '',
    '{mal_id}': ids?.malId || '',
    '{kitsu_id}': ids?.kitsuId || '',
    '{anilist_id}': ids?.anilistId || '',
    '{anidb_id}': ids?.anidbId || '',
    '{type}': type || '',
    '{season}': extra?.season != null ? String(extra.season) : '',
    '{episode}': extra?.episode != null ? String(extra.episode) : '',
    '{language}': lang,
    '{language_short}': lang.split('-')[0],
    '{tmdb_key}': config?.apiKeys?.tmdb || '',
    '{rpdb_key}': config?.apiKeys?.rpdb || '',
    '{top_key}': config?.apiKeys?.topPoster || '',
    '{mdblist_key}': config?.apiKeys?.mdblist || '',
    '{fanart_key}': config?.apiKeys?.fanart || '',
    '{user_agent}': extra?.userAgent || '',
  };

  // Optional placeholders — resolve to empty string without failing
  const optionalPlaceholders = {
    '{blur}': extra?.blur != null ? String(extra.blur) : '',
    '{thumbnail}': extra?.thumbnail || '',
  };

  let url = pattern;
  for (const [placeholder, value] of Object.entries(placeholders)) {
    if (url.includes(placeholder)) {
      if (!value) return null; // Referenced placeholder has no value — fall back
      url = url.split(placeholder).join(value);
    }
  }
  for (const [placeholder, value] of Object.entries(optionalPlaceholders)) {
    if (url.includes(placeholder)) {
      url = url.split(placeholder).join(value);
    }
  }

  if (url.includes('ratingposterdb.com') && (/(t0)-/.test(url) || /^(t0)-/.test(config?.apiKeys?.rpdb || ''))) {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.searchParams.has('lang')) {
        parsedUrl.searchParams.delete('lang');
        url = parsedUrl.toString();
      }
    } catch (e) {
      url = url.replace(/([?&])lang=[^&]*/g, (match, p1) => p1 === '?' ? '?' : '')
               .replace(/\?&/g, '?')
               .replace(/\?$/, '');
    }
  }

  return url;
}

/**
 * Resolve an RPDB/TOP rating poster URL with automatic ID fallback.
 * The user's pattern uses {imdb_id} — if that ID is unavailable, we internally
 * retry with tmdb then tvdb, adjusting the URL path and ID format accordingly.
 */
function resolveRatingPosterUrl(pattern, ids, type, config, extra) {
  const typePrefix = type === 'movie' ? 'movie' : 'series';

  // Try the pattern as-is first
  const direct = resolvePattern(pattern, ids, type, config, extra);
  if (direct) return direct;

  // Build fallback variants by swapping the id type segment and placeholder
  // RPDB/TOP URL structure: .../{id_type}/poster-default/{id}.jpg
  const fallbacks = [];
  if (pattern.includes('{imdb_id}')) {
    // Original uses imdb — try tmdb then tvdb
    if (ids?.tmdbId) fallbacks.push(pattern.replace('/imdb/', '/tmdb/').replace('{imdb_id}', `${typePrefix}-${ids.tmdbId}`));
    if (ids?.tvdbId) fallbacks.push(pattern.replace('/imdb/', '/tvdb/').replace('{imdb_id}', `${typePrefix}-${ids.tvdbId}`));
  } else if (pattern.includes('{tmdb_id}')) {
    if (ids?.imdbId) fallbacks.push(pattern.replace('/tmdb/', '/imdb/').replace(`${typePrefix}-{tmdb_id}`, ids.imdbId).replace('{tmdb_id}', ids.imdbId));
    if (ids?.tvdbId) fallbacks.push(pattern.replace('/tmdb/', '/tvdb/').replace('{tmdb_id}', ids.tvdbId));
  } else if (pattern.includes('{tvdb_id}')) {
    if (ids?.imdbId) fallbacks.push(pattern.replace('/tvdb/', '/imdb/').replace(`${typePrefix}-{tvdb_id}`, ids.imdbId).replace('{tvdb_id}', ids.imdbId));
    if (ids?.tmdbId) fallbacks.push(pattern.replace('/tvdb/', '/tmdb/').replace('{tvdb_id}', ids.tmdbId));
  }

  for (const fb of fallbacks) {
    const resolved = resolvePattern(fb, ids, type, config, extra);
    if (resolved) return resolved;
  }

  return null;
}

/** Default poster URL pattern for RPDB */
const RPDB_DEFAULT_PATTERN = 'https://api.ratingposterdb.com/{rpdb_key}/imdb/poster-default/{imdb_id}.jpg?fallback=true';
/** Default poster URL pattern for TOP Posters */
const TOP_DEFAULT_PATTERN = 'https://api.top-posters.com/{top_key}/imdb/poster/{imdb_id}.jpg?lang={language_short}';
/** Default episode thumbnail URL pattern for TOP Posters */
const TOP_DEFAULT_THUMBNAIL_PATTERN = 'https://api.top-posters.com/{top_key}/imdb/thumbnail/{imdb_id}/S{season}E{episode}.jpg?blur={blur}&fallback_url={thumbnail}&user_agent={user_agent}';

/**
 * Returns the default poster URL pattern for a given rating poster provider.
 * @param {'rpdb'|'top'} provider
 * @returns {string}
 */
function getDefaultPosterPattern(provider) {
  if (provider === 'rpdb') return RPDB_DEFAULT_PATTERN;
  if (provider === 'top') return TOP_DEFAULT_PATTERN;
  return '';
}

/**
 * Returns the default episode thumbnail URL pattern for a given provider.
 * @param {'top'} provider
 * @returns {string}
 */
function getDefaultThumbnailPattern(provider) {
  if (provider === 'top') return TOP_DEFAULT_THUMBNAIL_PATTERN;
  return '';
}

/**
 * Get poster URL from the selected rating provider (RPDB or Top Poster)
 */
function getRatingPosterUrl(type, ids, language, config, fallbackUrl = null) {
  const provider = config.posterRatingProvider || 'rpdb';

  if (provider === 'custom') {
    return null; // Custom uses URL patterns, not rating poster APIs
  }

  if (provider === 'top' && config.apiKeys?.topPoster) {
    return getTopPosterPoster(type, ids, language, config.apiKeys.topPoster, fallbackUrl);
  }

  // Default to RPDB
  if (config.apiKeys?.rpdb) {
    return getRpdbPoster(type, ids, language, config.apiKeys.rpdb);
  }

  return null;
}

/**
 * Get the API key for the selected poster rating provider
 */
function getPosterRatingApiKey(config) {
  const provider = config.posterRatingProvider || 'rpdb'; // Default to RPDB for backward compatibility

  if (provider === 'custom') {
    return null; // Custom uses URL patterns, not rating poster APIs
  }

  if (provider === 'top' && config.apiKeys?.topPoster) {
    return config.apiKeys.topPoster;
  }

  // Default to RPDB
  return config.apiKeys?.rpdb || null;
}

/**
 * Construct poster rating URL - direct for Top Poster, proxy for RPDB
 * Note: Top Poster API returns proper HTTP codes (200, 404, 401, 429, etc.)
 * For 429 (rate limit), we could use proxy for fallback, but since it's temporary,
 * we use direct URL and let Stremio handle it. For permanent errors (404, 401), 
 * Top Poster API returns proper codes that Stremio can handle.
 */
function buildPosterProxyUrl(host, type, proxyId, fallback, language, config) {
  const provider = config.posterRatingProvider || 'rpdb'; // Default to RPDB for backward compatibility
  const apiKey = getPosterRatingApiKey(config);
  
  if (!apiKey || !isPosterRatingEnabled(config)) {
    return fallback;
  }
  

  if (!config.usePosterProxy) {
    const [idSource, idValue] = proxyId.startsWith('tt') ? ['imdb', proxyId] : proxyId.split(':');
    
    // Construct IDs object for direct calling
    const ids = {
      tmdbId: idSource === 'tmdb' ? idValue : null,
      tvdbId: idSource === 'tvdb' ? idValue : null,
      imdbId: idSource === 'imdb' ? idValue : null,
    };

    const directUrl = getRatingPosterUrl(type, ids, language, config, fallback);
    return directUrl || fallback;
  }

  // Top Poster API returns proper HTTP codes and supports fallback_url parameter
  // When any error occurs (429, 404, 401, etc.), it will use the fallback_url
  // Note: Top Poster API only supports IMDb and TMDB IDs, not TVDB
  if (provider === 'top' && config.apiKeys?.topPoster) {
    // Extract IDs from proxyId format (e.g., "imdb:tt123", "tmdb:123", "tvdb:456")
    const [idSource, idValue] = proxyId.startsWith('tt') ? ['imdb', proxyId] : proxyId.split(':');
    
    // Top Poster API doesn't support TVDB IDs - return fallback
    if (idSource === 'tvdb') {
      return fallback;
    }
    
    const ids = {
      tmdbId: idSource === 'tmdb' ? idValue : null,
      tvdbId: null, // Top Poster API doesn't support TVDB
      imdbId: idSource === 'imdb' ? idValue : null,
    };
    const topPosterUrl = getTopPosterPoster(type, ids, language, config.apiKeys.topPoster, fallback);
    return topPosterUrl || fallback;
  }
  
  // RPDB needs proxy endpoint for fallback handling
  return `${host}/poster/${type}/${proxyId}?fallback=${encodeURIComponent(fallback)}&lang=${language}&key=${apiKey}`;
}

/**
 * Normalizes a string for searching:
 * - Converts to lowercase
 * - Removes accents and diacritics
 * - Converts & to 'and'
 * - Removes non-alphanumeric characters (except whitespace)
 * - Removes a leading "the "
 * - Collapses multiple spaces
 */
function normalize(str) {
  if (!str) return '';
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    // Convert dashes, underscores, slashes to spaces
    // eslint-disable-next-line no-useless-escape
    .replace(/[\u2010-\u2015–—−_\/]+/g, ' ')
    // Remove all other non-alphanumeric characters
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * Calculates Jaro-Winkler similarity between two strings.
 * Returns a value between 0 and 1, where 1 is an exact match.
 */
function jaroWinklerSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;

  const len1 = s1.length;
  const len2 = s2.length;
  const matchWindow = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);

  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const low = Math.max(0, i - matchWindow);
    const high = Math.min(len2 - 1, i + matchWindow);
    for (let j = low; j <= high; j++) {
      if (!s2Matches[j] && s1[i] === s2[j]) {
        s1Matches[i] = s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const m = matches;
  const jaro = (m / len1 + m / len2 + (m - transpositions / 2) / m) / 3;

  // Winkler boost
  let jw = jaro;
  if (jaro > 0.7) {
    let prefix = 0;
    const maxPrefix = 4;
    for (let i = 0; i < Math.min(len1, len2, maxPrefix); i++) {
      if (s1[i] === s2[i]) prefix++;
      else break;
    }
    jw = jaro + prefix * 0.1 * (1 - jaro);
  }

  return Math.min(1, jw);
}


function sortSearchResults(results, query) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return results;
  
  const queryWords = normalizedQuery.split(/\s+/).filter((w) => w);
  const personMatchCount = results.filter((r) => r.matchType === "person").length;
  const titleMatchCount = results.length - personMatchCount;
  const isPersonSearchIntent = personMatchCount > titleMatchCount && personMatchCount > 5;

  // 1. DECORATE
  const processedResults = results.map((item) => {
    const title = normalize(item.name || item.title || "");
    const score = Math.round((item.popularity || item.score || 0) * 10) / 10;
    const voteCount = item.vote_count || 0;
    const rawYearString = item.release_date || item.first_air_date;
    const year = rawYearString ? parseInt(rawYearString.substring(0, 4), 10) || 0 : 0;
    const isPersonMatch = item.matchType === "person" && isPersonSearchIntent;
    const isExact = title === normalizedQuery;

    // Quality checks
    const isEstablishedClassic = voteCount >= 1000;
    const isStandardHit = voteCount >= 200 && score >= 2.0 && year >= new Date().getFullYear() - 15;
    const isRecentUpAndComer = item.year && item.year >= new Date().getFullYear() - 2 && voteCount >= 50 && score >= 1.5;
    const passesExactQuality = isEstablishedClassic || isStandardHit || isRecentUpAndComer;

    // Match types
    // Use Jaro-Winkler for better typo tolerance (especially for prefix matches)
    const similarity = jaroWinklerSimilarity(title, normalizedQuery);
    
    const isNearExact = similarity >= 0.97; //slight typo tolerance
    
    const startsWith = !isExact && !isNearExact && !isPersonMatch && title.startsWith(normalizedQuery);
    const contains = !isExact && !isNearExact && !isPersonMatch && !startsWith && queryWords.every((word) => title.includes(word));

    let matchReason = "Other";
    if ((isExact || isNearExact) && passesExactQuality) matchReason = "ExactHQ";
    else if (isExact || isNearExact) matchReason = "Exact";
    else if (isPersonMatch) matchReason = "Person";
    else if (startsWith) matchReason = "StartsWith";
    else if (contains) matchReason = "Contains";

    return {
      originalItem: item,
      title,
      score,
      voteCount,
      voteAverage: item.vote_average || 0,
      year,
      isExact,
      passesExactQuality,
      isPersonMatch,
      startsWith,
      contains,
      similarity,
      id: item.id,
      poster_path: item.poster_path,
      mediaType: item.media_type,
      genre_ids: item.genre_ids,
      matchReason,
    };
  });

  // 2. FILTER
  const RULES = {
    CURRENT_YEAR: new Date().getFullYear(),
    HQ_VOTE_THRESHOLD: 100,
    HQ_POPULARITY_THRESHOLD: 5.0,
    LQ_EXACT: { MIN_VOTES: 1, MIN_POPULARITY: 0.5, RECENT_YEAR_SPAN: 5 },
    STARTS_WITH: {
      MIN_VOTES: 15,
      MIN_POPULARITY: 1,
      CURRENT_YEAR_MIN_VOTES: 1,
      CURRENT_YEAR_MIN_POPULARITY: 0.5,
    },
    CONTAINS: { MIN_VOTES: 10, MIN_SIMILARITY: 0.4 },
    OTHER: { MIN_VOTES: 50, MIN_POPULARITY: 2.5 },
    OBSCURE: { AGE_CUTOFF: 20, MAX_POPULARITY: 0.5, MAX_VOTES: 5 },
  };

  let filteredResults = processedResults.filter((item) => {
    // Stage 1: Priority Pass
    const isFightingEvent = /^(?=.*\b(UFC|LFA|PFL|Bellator)\b)(?=.*\b\w+\s+vs\.?\s+\w+\b).*/i.test(item.title);
    const isPriorityItem =
      (item.isExact && item.passesExactQuality) ||
      item.isPersonMatch ||
      isFightingEvent ||
      item.voteCount >= RULES.HQ_VOTE_THRESHOLD ||
      item.score >= RULES.HQ_POPULARITY_THRESHOLD;
    
    if (isPriorityItem) return true;

    // Stage 2: Hard Fail
    const isMissingCoreData = !item.year || item.year === 0 || !item.poster_path;
    const isObscureContent =
      item.year < (RULES.CURRENT_YEAR - RULES.OBSCURE.AGE_CUTOFF) &&
      item.score < RULES.OBSCURE.MAX_POPULARITY &&
      item.voteCount < RULES.OBSCURE.MAX_VOTES;
    
    if (isMissingCoreData || (isObscureContent && !item.isExact && !item.isNearExact)) return false;

    // Stage 3: Case-by-Case Rules
    switch (item.matchReason) {
      case "Exact": {
        const isRecent = item.year >= RULES.CURRENT_YEAR - RULES.LQ_EXACT.RECENT_YEAR_SPAN;
        const hasBasicEngagement = item.voteCount >= RULES.LQ_EXACT.MIN_VOTES || item.score >= RULES.LQ_EXACT.MIN_POPULARITY;
        const hasAnyRecentEngagement = isRecent && (item.voteCount > 0 || item.score > 0);
        return hasBasicEngagement || hasAnyRecentEngagement;
      }

      case "StartsWith": {
        const isCurrentYear = item.year === RULES.CURRENT_YEAR;
        if (isCurrentYear) {
          return item.voteCount >= RULES.STARTS_WITH.CURRENT_YEAR_MIN_VOTES || item.score >= RULES.STARTS_WITH.CURRENT_YEAR_MIN_POPULARITY;
        }
        return item.voteCount >= RULES.STARTS_WITH.MIN_VOTES || item.score >= RULES.STARTS_WITH.MIN_POPULARITY;
      }

      case "Contains":
        return item.voteCount >= RULES.CONTAINS.MIN_VOTES && item.similarity >= RULES.CONTAINS.MIN_SIMILARITY;

      case "Other":
        return item.voteCount >= RULES.OTHER.MIN_VOTES && item.score >= RULES.OTHER.MIN_POPULARITY;

      default:
        return false;
    }
  });

  // Stage 4: Safety Net Fallback
  if (filteredResults.length === 0 && processedResults.length > 0) {
    logger.warn("⚠️ Filtering removed all results. Falling back to top 5 most popular.");
    filteredResults = [...processedResults]
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        return b.voteCount - a.voteCount;
      })
      .slice(0, 5);
  }

  // 3. SIMPLIFIED SORT
  // Person matches -> ExactHQ (by similarity) -> Quality Score (popularity + votes + recency) -> Release date
  filteredResults.sort((a, b) => {
    // 1. Person matches first (only if person search intent detected)
    if (isPersonSearchIntent) {
      const aIsPerson = a.isPersonMatch ? 1 : 0;
      const bIsPerson = b.isPersonMatch ? 1 : 0;
      if (aIsPerson !== bIsPerson) return bIsPerson - aIsPerson;
    }

    // 2. ExactHQ matches
    const aIsExactHQ = a.matchReason === "ExactHQ" ? 1 : 0;
    const bIsExactHQ = b.matchReason === "ExactHQ" ? 1 : 0;
    if (aIsExactHQ !== bIsExactHQ) return bIsExactHQ - aIsExactHQ;

    // 2a. If both are ExactHQ, prioritize by similarity
    if (aIsExactHQ && bIsExactHQ && a.similarity !== b.similarity) {
      return b.similarity - a.similarity;
    
    }
    // 3. Composite Quality Score
    // Combines popularity (engagement), votes (validation), recency, and similarity
    const calculateQualityScore = (item) => {
      const currentYear = new Date().getFullYear();
      const age = currentYear - item.year;
      
      // Popularity component (0-100+ range)
      const popularityScore = item.score;
      
      // Vote component using logarithmic scale (prevents low-vote items from ranking high)
      // log10(10000) ≈ 4, log10(1000) ≈ 3, log10(100) ≈ 2, log10(10) ≈ 1, log10(1) = 0
      const voteScore = Math.log10(item.voteCount + 1) * 5; // Scale up to ~20 for 10k votes
      
      // Recency bonus (newer content gets a small boost, older gets slight penalty)
      // Content from last 5 years gets +5 to +1 bonus, 6-15 years neutral, older gets penalty
      let recencyBonus = 0;
      if (age <= 5) {
        recencyBonus = (5 - age) * 1; // +5 for current year, +4 for 1 year old, etc.
      } else if (age > 20) {
        recencyBonus = -Math.min(age - 20, 10) * 0.5; // Penalty for very old content, capped at -5
      }
      
      // Similarity component
      // "Other" matches don't get similarity boost - they're already weak
      const similarityScore = 
        (item.matchReason === "Other") ? 0 : item.similarity * 10;
      
      // Final score: popularity + vote validation + recency + similarity
      return popularityScore + voteScore + recencyBonus + similarityScore;
    };
    
    const aQualityScore = calculateQualityScore(a);
    const bQualityScore = calculateQualityScore(b);
    if (aQualityScore !== bQualityScore) return bQualityScore - aQualityScore;

    // 4. Release date as final tiebreaker (newer first)
    if (a.year !== b.year) return b.year - a.year;

    return 0;
  });

  // 4. LOGGING (debug only)
  if (isDebugEnabled) {
    logger.debug(
      `Intent: ${isPersonSearchIntent ? "Persons" : "Title"} | Query: "${query}" | Raw Matches: ${processedResults.length}`
    );

    const formatForTable = (item) => ({
      Title: item.title.substring(0, 35),
      Year: item.year || "----",
      Pop: item.score.toFixed(1),
      Votes: item.voteCount,
      Sim: item.similarity.toFixed(2),
      Reason: item.matchReason,
    });

    if (filteredResults.length > 0) {
      logger.debug("✅ FINAL SORTED RESULTS (Top 20):");
      console.table(filteredResults.slice(0, 20).map((item) => formatForTable(item)));
    }

    const filteredOutItems = processedResults.filter((item) => !filteredResults.includes(item));
    if (filteredOutItems.length > 0) {
      logger.debug("❌ ITEMS FILTERED OUT (Top 20):");
      console.table(filteredOutItems.slice(0, 20).map((item) => formatForTable(item)));
    }
  }

  return filteredResults.map((p) => p.originalItem);
}


function parseMedia(el, type, genreList = [], config = {}) {
  const genres = Array.isArray(el.genre_ids) && genreList.length > 0
    ? el.genre_ids.map(genreId => (genreList.find((g) => g.id === genreId) || {}).name).filter(Boolean)
    : el?.genres ? parseGenres(el.genres) : [];

  let name = type === 'movie' ? el.title : el.name;

  if(el.translations){
    el.overview = processOverviewTranslations(el.translations, config.language, el.overview);
    const originalTitle = type === 'movie' ? el.original_title : el.original_name;
    name = processTitleTranslations(el.translations, config.language, name, type, el.original_language, originalTitle);
  }

  return {
    id: `tmdb:${el.id}`,
    name: name,
    genres: genres,
    poster: el.poster_path ? `https://image.tmdb.org/t/p/w500${el.poster_path}` : null,
    background: el.backdrop_path ? `https://image.tmdb.org/t/p/original${el.backdrop_path}` : null,
    posterShape: "regular",
    imdbRating: el.vote_average ? el.vote_average.toFixed(1) : 'N/A',
    year: type === 'movie' ? (el.release_date?.substring(0, 4) || '') : (el.first_air_date?.substring(0, 4) || ''),
    type: type === 'movie' ? type : 'series',
    released: type === 'movie' ? new Date(el.release_date) : new Date(el.first_air_date),
    releaseInfo: type === 'movie' ? (el.release_date?.substring(0, 4) || '') : (el.first_air_date?.substring(0, 4) || ''),
    description: addMetaProviderAttribution(el.overview, 'TMDB', config),
    popularity: el.popularity, 
    vote_average: el.vote_average || 0,
    vote_count: el.vote_count || 0,
    matchType: el.matchType || 'title',
  };
}

/**
 * Sorts and filters TVDB search results to provide the most relevant matches first.
 * This function creates a relevance score based on match type, data completeness,
 * series status, and recency.
 * @param {Array} results - The array of parsed TVDB search results.
 * @param {string} query - The original search query.
 * @returns {Array} The sorted and filtered search results.
 */
function sortTvdbSearchResults(results, query) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return results;
  logger.debug(`[TVDB Sort] Processing ${results.length} results for query: "${normalizedQuery}"`);
  // Regex to remove trailing years in parentheses, e.g., " (2023)"
  const yearRegex = /\s\(\d{4}\)$/;
  const currentYear = new Date().getFullYear();
  
  // Threshold for 'Contains' matches
  const CONTAINS_SIMILARITY_THRESHOLD = 0.20;
  
  // 1. DECORATE results with properties needed for sorting and filtering.
  const processedResults = results.map((item) => {
    // Clean the primary title by removing the year before normalizing
    const cleanedTitle = (item.name || "").replace(yearRegex, '');
    const title = normalize(cleanedTitle);
    
    // Collect all possible names (primary, aliases, translations) for matching
    const allTitles = [
      title,
      ...(item.aliases || []),
      ...(item.translations || [])
    ]
      .filter(t => t && typeof t === 'string') // Only keep non-empty strings
      .map(t => normalize(t.replace(yearRegex, '')));
    
    // Handle 'Upcoming' status for year parsing
    const year = item.status === 'Upcoming' ? 9999 : (parseInt(item.year, 10) || 0);
    
    // Use Jaro-Winkler for similarity calculation (only on primary title)
    const similarity = jaroWinklerSimilarity(title, normalizedQuery);
    
    // Pre-compute query components for matching logic
    const queryWords = normalizedQuery.split(/\s+/);
    const queryNoSpaces = normalizedQuery.replace(/\s+/g, '');
    
    // Find the best match type across all title variants
    let bestMatchReason = "Other";
    
    for (const currentTitle of allTitles) {
      // Check for exact match
      if (currentTitle === normalizedQuery) {
        bestMatchReason = "Exact";
        break; // Can't get better than exact
      }
      
      // Check for startsWith match
      const startsWith = currentTitle.startsWith(normalizedQuery) && (
        currentTitle.length === normalizedQuery.length ||
        [' ', ':'].includes(currentTitle[normalizedQuery.length])
      );
      
      if (startsWith && bestMatchReason !== "Exact") {
        bestMatchReason = "StartsWith";
        continue; // Keep checking for potential exact match
      }
      
      // Check for contains match (whole words or substring without spaces)
      const titleWords = new Set(currentTitle.split(/\s+/));
      const containsAsWords = queryWords.every(word => titleWords.has(word));
      
      const titleNoSpaces = currentTitle.replace(/\s+/g, '');
      const containsAsString = titleNoSpaces.includes(queryNoSpaces);
      
      const contains = containsAsWords || containsAsString;
      
      if (contains && bestMatchReason === "Other") {
        bestMatchReason = "Contains";
      }
    }
    
    // A real poster exists if the raw URL from the API was not null/undefined.
    const hasRealPoster = !!item._rawPosterUrl;
    
    return {
      originalItem: item,
      title, // Use the cleaned and normalized primary title for display
      year,
      similarity,
      matchReason: bestMatchReason,
      hasPoster: hasRealPoster,
      hasOverview: !!(item.description && item.description.trim() !== ''),
      isContinuing: item.status === "Continuing",
      isUpcoming: item.status === "Upcoming",
    };
  });
  
  // 2. FILTER out the lowest quality results.
  let filteredResults = processedResults.filter(item => {
    // Only filter out "Other" if it's NOT similar enough
    if (item.matchReason === "Other" && item.similarity < 0.80) {
      return false;
    }
    if (!item.year && !item.isUpcoming) {
        return false;
    }
    if (item.matchReason === "Contains") {
      const isRecent = item.year >= currentYear - 2;
      const isSimilarEnough = item.similarity >= CONTAINS_SIMILARITY_THRESHOLD;
      // Keep if it's either recent OR similar enough. Filter out if it's neither.
      if (!isRecent && !isSimilarEnough) {
        return false;
      }
    }
    // Only remove if it's missing BOTH a poster AND an overview.
    const isLowQuality = !item.hasPoster && !item.hasOverview;
    if (isLowQuality) {
      return false;
    }
    
    return true;
  });
  
  // Safety net: If filtering removed everything, fall back to top 5 in original API order
  if (filteredResults.length === 0 && processedResults.length > 0) {
    logger.warn(
      "⚠️ Filtering removed all results. Falling back to top 5 in original order."
    );
    filteredResults = processedResults.slice(0, 5);
  }
  
  // 3. SORT the filtered results based on our relevance hierarchy.
  filteredResults.sort((a, b) => {
    // Primary Sort: Absolutely prioritize items WITH a poster over those without.
    if (a.hasPoster !== b.hasPoster) {
      return a.hasPoster ? -1 : 1;
    }
    // De-prioritize "Upcoming" items below all other released content.
    if (a.isUpcoming !== b.isUpcoming) {
      return a.isUpcoming ? 1 : -1;
    }
    // Preserve the original API order as the tie-breaker.
    return 0;
  });
  
  
  // 4. LOGGING for verification and debugging.
  if (isDebugEnabled) {
    logger.debug(
      `[TVDB Sort] Query: "${query}" | Raw Matches: ${processedResults.length}`
    );
    const formatForTable = (item) => ({
      Title: item.originalItem.name.substring(0, 35),
      Year: item.year === 9999 ? 'TBA' : item.year || "----",
      Similarity: item.similarity.toFixed(2),
      Reason: item.matchReason,
      Status: item.originalItem.status || 'N/A',
      HasPoster: item.hasPoster ? 'Yes' : 'No',
    });
    if (filteredResults.length > 0) {
      logger.debug("✅ FINAL SORTED RESULTS:");
      console.table(filteredResults.map(formatForTable));
    }
    const filteredOut = processedResults.filter(
      (item) => !filteredResults.includes(item)
    );
    if (filteredOut.length > 0) {
      logger.debug("❌ ITEMS FILTERED OUT:");
      console.table(filteredOut.map(formatForTable));
    }
  }
  
  // 5. Return the original items in the newly sorted order.
  return filteredResults.map(p => p.originalItem);
}

function getTvdbCertification(contentRatings, countryCode, contentType) {
  if (!contentRatings || !Array.isArray(contentRatings)) {
    return null;
  }

  let certification = contentRatings.find(rating => 
    rating.country?.toLowerCase() === countryCode?.toLowerCase() && 
    (!contentType || rating.contentType === contentType || rating.contentType === '')
  );
  
  if (!certification) {
    certification = contentRatings.find(rating => 
      rating.country?.toLowerCase() === 'usa' && 
      (!contentType || rating.contentType === contentType || rating.contentType === '')
    );
  }
  
  return certification?.name || null;
}

function processOverviewTranslations(translations, language, overview) {
  if(language === 'pt-PT'){
    let translation = tmdb.getTranslations(translations, 'pt-PT');
      if(translation && translation.data.overview && translation.data.overview.trim() !== ''){
        overview = translation.data.overview;
      } else {
        translation = tmdb.getTranslations(translations, 'pt-BR');
        if(translation && translation.data.overview && translation.data.overview.trim() !== ''){
          overview = translation.data.overview;
        } else{
          translation = tmdb.getTranslations(translations, 'en-US');
          if(translation && translation.data.overview && translation.data.overview.trim() !== ''){
            overview = translation.data.overview;
          }
        }
      }
    } else {
      let translation = tmdb.getTranslations(translations, language);
      if(translation && translation.data.overview && translation.data.overview.trim() !== ''){
        overview = translation.data.overview;
      } else {
        translation = tmdb.getTranslations(translations, 'en-US');
        if(translation && translation.data.overview && translation.data.overview.trim() !== ''){
          overview = translation.data.overview;
        }
      }
    }
  return overview;
}

function processTitleTranslations(translations, language, title, type, originalLanguage = null, originalTitle = null) {
  // Extract base language code from user's language (e.g., "pl-PL" -> "pl", "en-US" -> "en")
  const baseLanguage = language ? language.split('-')[0].toLowerCase() : null;
  // Check if user's language matches the original language
  const languagesMatch = originalLanguage && baseLanguage && originalLanguage.toLowerCase() === baseLanguage;
  
  // Handle title fallback for pt-PT language
  if(language === 'pt-PT'){
    let translation = tmdb.getTranslations(translations, 'pt-PT');
    if(translation && (translation.data.title || translation.data.name) && (translation.data.title || translation.data.name).trim() !== ''){
      title = type === 'movie' ? translation.data.title : translation.data.name;
    } else {
      translation = tmdb.getTranslations(translations, 'pt-BR');
      if(translation && (translation.data.title || translation.data.name) && (translation.data.title || translation.data.name).trim() !== ''){
        title = type === 'movie' ? translation.data.title : translation.data.name;
      } else {
        // If languages match and no translation found, use original title instead of English fallback
        if(languagesMatch && originalTitle && originalTitle.trim() !== ''){
          title = originalTitle;
        } else {
          translation = tmdb.getTranslations(translations, 'en-US');
          if(translation && (translation.data.title || translation.data.name) && (translation.data.title || translation.data.name).trim() !== ''){
            title = type === 'movie' ? translation.data.title : translation.data.name;
          } else if(languagesMatch && originalTitle && originalTitle.trim() !== ''){
            // Fallback to original title if English also not found
            title = originalTitle;
          }
        }
      }
    }
  } else {
    let translation = tmdb.getTranslations(translations, language);
    if(translation && (translation.data.title || translation.data.name) && (translation.data.title || translation.data.name).trim() !== ''){
      title = type === 'movie' ? translation.data.title : translation.data.name;
    } else {
      // If languages match and no translation found, use original title instead of English fallback
      if(languagesMatch && originalTitle && originalTitle.trim() !== ''){
        title = originalTitle;
      } else {
        translation = tmdb.getTranslations(translations, 'en-US');
        if(translation && (translation.data.title || translation.data.name) && (translation.data.title || translation.data.name).trim() !== ''){
          title = type === 'movie' ? translation.data.title : translation.data.name;
        } else if(languagesMatch && originalTitle && originalTitle.trim() !== ''){
          // Fallback to original title if English also not found
          title = originalTitle;
        }
      }
    }
  }
  return title;
}

// Helper function to add meta provider attribution to overview
const addMetaProviderAttribution = (overview, provider, config) => {
  // Check if meta provider attribution is enabled
  if (!config?.showMetaProviderAttribution) {
    return overview;
  }
  
  if (!overview) return `[Meta provided by ${provider}]`;
  return `${overview}\n\n[Meta provided by ${provider}]`;
};



function parseCast(credits, count, metaProvider = 'tmdb') {
  if (!credits || !Array.isArray(credits.cast)) return [];
  const cast = credits.cast;
  const toParse = count === undefined || count === null ? cast : cast.slice(0, count);

  return toParse.map((el) => {
    let photoUrl = null;
    if (metaProvider === 'tmdb') {
      if (el.profile_path) {
        if (el.profile_path.startsWith('http')) {
          photoUrl = el.profile_path;
        } else {
            photoUrl = `https://image.tmdb.org/t/p/w276_and_h350_face${el.profile_path}`;
        }
      }
    }
    else {
      photoUrl = el.photo;
    }
    return {
      name: el.name,
      character: el.character,
      photo: photoUrl
    };
  });
}

function parseDirector(credits) {
  if (!credits || !Array.isArray(credits.crew)) return [];
  return credits.crew.filter((x) => x.job === "Director").map((el) => el.name);
}

function parseWriter(credits) {
    if (!credits || !Array.isArray(credits.crew)) return [];
    const writers = credits.crew.filter((x) => x.department === "Writing").map((el) => el.name);
    const creators = credits.crew.filter((x) => x.job === "Creator").map((el) => el.name);
    return [...new Set([...writers, ...creators])];
}

function parseSlug(type, title, imdbId, uniqueIdFallback = null) {
  const safeTitle = (title || '')
    .toLowerCase()
    .replace(/ /g, "-");

  let identifier = '';
  if (imdbId) {
    identifier = imdbId.replace('tt', '');
  } else if (uniqueIdFallback) {
    identifier = String(uniqueIdFallback);
  }

  return identifier ? `${type}/${safeTitle}-${identifier}` : `${type}/${safeTitle}`;
}

function parseTrailers(videos) {
    if (!videos || !Array.isArray(videos.results)) return [];
    return videos.results
        .filter((el) => el.site === "YouTube" && el.type === "Trailer")
        .map((el) => ({ source: el.key, type: el.type, name: el.name, ytId: el.key, lang: el.iso_639_1 }));
}

function parseTrailerStream(videos) {
    if (!videos || !Array.isArray(videos.results)) return [];
    return videos.results
        .filter((el) => el.site === "YouTube" && el.type === "Trailer")
        .map((el) => ({ title: el.name, ytId: el.key, lang: el.iso_639_1 }));
}

function parseImdbLink(vote_average, imdb_id) {
  return {
    name: vote_average,
    category: "imdb",
    url: `https://imdb.com/title/${imdb_id}`,
  };
}

function parseShareLink(title, imdb_id, type) {
  return {
    name: title,
    category: "share",
    url: `https://www.strem.io/s/${parseSlug(type, title, imdb_id)}`,
  };
}

function parseAnimeGenreLink(genres, type, userUUID) {
  if (!Array.isArray(genres) || !process.env.HOST_NAME) return [];
  
  const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;
    
  const manifestPath = userUUID ? `stremio/${userUUID}/manifest.json` : 'manifest.json';
  const manifestUrl = `${host}/${manifestPath}`;  

  return genres.map((genre) => {
    if (!genre) return null;

    let searchUrl;
    let url = `stremio:///discover/${encodeURIComponent(
      manifestUrl
    )}/anime/mal.genres?genre=${genre}`;
    if (type === 'movie') {
      url += `&type_filter=movie`;
    } else if (type === 'series') {
      url += `&type_filter=tv`;
    }
    searchUrl = url;

    return {
      name: genre,
      category: "Genres",
      url: searchUrl,
    };
  }).filter(Boolean);
}

function parseGenreLink(genres, type, userUUID, isTvdb = false) {
  if (!Array.isArray(genres) || !process.env.HOST_NAME) return [];
  
  const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;
    
  const manifestPath = userUUID ? `stremio/${userUUID}/manifest.json` : 'manifest.json';
  const manifestUrl = `${host}/${manifestPath}`;

  return genres.map((genre) => {
    if (!genre || !genre.name) return null;

    let searchUrl;
    if (isTvdb) {
      searchUrl = `stremio:///discover/${encodeURIComponent(
        manifestUrl
      )}/${type}/tvdb.genres?genre=${encodeURIComponent(
        genre.name
      )}`;
    } else {
      searchUrl = `stremio:///discover/${encodeURIComponent(
        manifestUrl
      )}/${type}/tmdb.top?genre=${encodeURIComponent(
        genre.name
      )}`;
    }

    return {
      name: genre.name,
      category: "Genres",
      url: searchUrl,
    };
  }).filter(Boolean);
}

function parseCreditsLink(credits, castCount, metaProvider = 'tmdb') {
  const castData = parseCast(credits, castCount, metaProvider);
  const Cast = castData.map((actor) => ({
    name: actor.name, category: "Cast", url: `stremio:///search?search=${encodeURIComponent(actor.name)}`
  }));
  
  if (castCount === 0) {
    return [...Cast];
  }
  
  const Director = parseDirector(credits).map((director) => ({
    name: director, category: "Directors", url: `stremio:///search?search=${encodeURIComponent(director)}`,
  }));
  const Writer = parseWriter(credits).map((writer) => ({
    name: writer, category: "Writers", url: `stremio:///search?search=${encodeURIComponent(writer)}`,
  }));
  return [...Cast, ...Director, ...Writer];
}



function buildLinks(imdbRating, imdbId, title, type, genres, credits, language, castCount, userUUID, isTvdb = false, metaProvider = 'tmdb') {
  const links = [];

  if (imdbId) {
    links.push(parseImdbLink(imdbRating, imdbId));
    links.push(parseShareLink(title, imdbId, type));
  }

  const genreLinks = parseGenreLink(genres, type, userUUID, isTvdb);
  if (genreLinks.length > 0) {
    links.push(...genreLinks);
  }

  const creditLinks = parseCreditsLink(credits, castCount, metaProvider);
  if (creditLinks.length > 0) {
    links.push(...creditLinks);
  }
  return links.filter(Boolean);
}


function parseCoutry(production_countries) {
  return production_countries?.map((country) => country.name).join(", ") || '';
}

function parseGenres(genres) {
  return genres?.map((el) => el.name) || [];
}

function parseYear(status, first_air_date, last_air_date) {
  const startYear = first_air_date ? first_air_date.substring(0, 4) : '';
  if (!startYear) return '';
  
  // If series has ended and we have a last air date, show year range
  if (status === "Ended" && last_air_date) {
    const endYear = last_air_date.substring(0, 4);
    return startYear === endYear ? startYear : `${startYear}-${endYear}`;
  }
  
  // If series is ongoing (Running, In Development, etc.), show "year-"
  if (status && status !== "Ended" && status !== "Canceled") {
    return `${startYear}-`;
  }
  
  return startYear;
}


function parseAnimeCreditsLink(characterData, userUUID, castCount) {
  if (!characterData || !characterData.length === 0) return [];

  const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;
    
  const manifestPath = userUUID ? `stremio/${userUUID}/manifest.json` : 'manifest.json';
  const manifestUrl = `${host}/${manifestPath}`;

  const charactersToProcess = castCount === undefined || castCount === null ? characterData : characterData.slice(0, castCount);
  const voiceActorLinks = charactersToProcess.map(charEntry => {
    const voiceActor = charEntry.voice_actors.find(va => va.language === 'Japanese');
    if (!voiceActor) return null;

    const vaMalId = voiceActor.person.mal_id;

    const searchUrl = `stremio:///discover/${encodeURIComponent(
      manifestUrl
    )}/anime/mal.va_search?va_id=${vaMalId}`;

    return {
      name: voiceActor.person.name,
      category: 'Cast',
      url: searchUrl
    };
  }).filter(Boolean);

  return [...voiceActorLinks];
}

function getTmdbMovieCertificationForCountry(certificationsData) {
  if (!certificationsData) {
    return null;
  }
  
  const countryData = certificationsData.results?.find(r => r.iso_3166_1 === 'US');
  if (!countryData?.release_dates) return null;
  
  // Step 1: Find the most recent theatrical release with non-empty certification
  const theatricalWithCert = countryData.release_dates
    .filter(rd => rd.type === 3 && rd.certification && rd.certification.trim() !== '')
    .sort((a, b) => new Date(b.release_date) - new Date(a.release_date));
  
  if (theatricalWithCert.length > 0) {
    return theatricalWithCert[0].certification;
  }
  
  // Step 2: If no theatrical releases have certification, find any release with certification data
  const anyWithCert = countryData.release_dates
    .filter(rd => rd.certification && rd.certification.trim() !== '')
    .sort((a, b) => new Date(b.release_date) - new Date(a.release_date));
  
  if (anyWithCert.length > 0) {
    return anyWithCert[0].certification;
  }
  
  // Step 3: No certification data found
  return null;
}

function getTmdbTvCertificationForCountry(certificationsData) {
  if (!certificationsData) {
    return null;
  }
  
  const countryData = certificationsData.results?.find(r => r.iso_3166_1 === 'US');
  if (!countryData?.rating) return null;
  
  return countryData.rating;
}


function parseAnimeRelationsLink(relationsData, type, userUUID) {
  if (!Array.isArray(relationsData) || relationsData.length === 0) {
    return [];
  }


  const relationLinks = relationsData.flatMap(relation => {
    const relationType = relation.relation;
    if (relationType !== 'Prequel' && relationType !== 'Sequel') {
      return [];
    }

    return (relation.entry || []).map(entry => {
      if (!entry.mal_id || !entry.name) return null;

      // Construct meta URL with proper UUID route if available
      const metaUrl = `stremio:///detail/${type}/mal:${entry.mal_id}`;

      return {
        name: entry.name,
        category: relationType,
        url: metaUrl
      };
    }).filter(Boolean);
  });

  return relationLinks;
}


async function getAnimeGenres() {
  return jikan.getAnimeGenres().catch((e) => {
    logger.error(`Could not fetch anime genres from Jikan`, e.message);
    return [];
  });
}



function parseRunTime(runtime) {
  if (!runtime) return "";

  let totalMinutes;

  if (typeof runtime === 'number') {
    totalMinutes = runtime;
  }
  else if (typeof runtime === 'string') {
    let hours = 0;
    let minutes = 0;

    const hourMatch = runtime.match(/(\d+)\s*hr?/);
    if (hourMatch) {
      hours = parseInt(hourMatch[1], 10);
    }

    const minuteMatch = runtime.match(/(\d+)\s*min?/);
    if (minuteMatch) {
      minutes = parseInt(minuteMatch[1], 10);
    }
    if (hours === 0 && minutes === 0) {
      totalMinutes = parseInt(runtime, 10);
    } else {
      totalMinutes = (hours * 60) + minutes;
    }

  } else {
    return "";
  }

  if (isNaN(totalMinutes) || totalMinutes <= 0) {
    return "";
  }

  const finalHours = Math.floor(totalMinutes / 60);
  const finalMinutes = totalMinutes % 60;

  if (finalHours > 0) {
    const hourString = `${finalHours}h`;
    const minuteString = finalMinutes > 0 ? `${finalMinutes}min` : '';
    return `${hourString}${minuteString}`;
  } else {
    return `${finalMinutes}min`;
  }
}

function parseCreatedBy(created_by) {
  return created_by?.map((el) => el.name).join(', ') || '';
}

function parseConfig(catalogChoices) {
  if (!catalogChoices) return {};
  try {
    const config = JSON.parse(decompressFromEncodedURIComponent(catalogChoices));
    
    // Debug: Log art provider configuration
    if (config.artProviders) {
      // logger.debug(`[Config Debug] Art providers:`, config.artProviders);
    }
    
    return config;
  } catch (e) {
    try { 
      const config = JSON.parse(catalogChoices);
      
      // Debug: Log art provider configuration
      if (config.artProviders) {
        // logger.debug(`[Config Debug] Art providers:`, config.artProviders);
      }
      
      return config; 
    } catch { return {}; }
  }
}

function getRpdbPoster(type, ids, language, rpdbkey) {
    const tier = rpdbkey.split("-")[0]
    const lang = language.split("-")[0]
    const { tmdbId, tvdbId } = ids;
    let baseUrl = `https://api.ratingposterdb.com`;
    let idType = null;
    let fullMediaId = null;
    if (type === 'movie') {
        if (tvdbId) {
            idType = 'tvdb';
            fullMediaId = `movie-${tvdbId}`;
        } else if (tmdbId) {
            idType = 'tmdb';
            fullMediaId = `movie-${tmdbId}`;
        } else if (ids.imdbId) {
            idType = 'imdb';
            fullMediaId = ids.imdbId;
        }
    } else if (type === 'series') {
        if (tvdbId) {
            idType = 'tvdb';
            fullMediaId = `series-${tvdbId}`;
        } else if (tmdbId) {
            idType = 'tmdb';
            fullMediaId = `series-${tmdbId}`;
        } else if (ids.imdbId) {
            idType = 'imdb';
            fullMediaId = ids.imdbId;
        }
    }
    if (!idType || !fullMediaId) {
        return null;
    }

    const urlPath = `${baseUrl}/${rpdbkey}/${idType}/poster-default/${fullMediaId}.jpg`;
    //console.log(urlPath);
    if (tier === "t0" || tier === "t1" || lang === "en") {
        return `${urlPath}?fallback=true`;
    } else {
        return `${urlPath}?fallback=true&lang=${lang}`;
    }
}

function getTopPosterPoster(type, ids, language, topPosterKey, fallbackUrl = null) {
    const { tmdbId, imdbId } = ids;
    let baseUrl = `https://api.top-posters.com`;
    let idType = null;
    let fullMediaId = null;
    
    // Top Poster API supports only IMDb and TMDB
    if (type === 'movie') {
        if (tmdbId) {
            idType = 'tmdb';
            fullMediaId = `movie-${tmdbId}`;
        } else if (imdbId) {
            idType = 'imdb';
            fullMediaId = imdbId;
        }
    } else if (type === 'series') {
        if (tmdbId) {
            idType = 'tmdb';
            fullMediaId = `series-${tmdbId}`;
        } else if (imdbId) {
            idType = 'imdb';
            fullMediaId = imdbId;
        }
    }
    
    if (!idType || !fullMediaId) {
        return null;
    }

    // Top Poster API format: /{api_key}/{id_type}/poster/{media_id}.jpg
    const urlPath = `${baseUrl}/${topPosterKey}/${idType}/poster/${fullMediaId}.jpg`;
    
    // Build query parameters
    // Top Poster API expects ISO 639-1 format (2-letter language code, e.g., 'en', 'it', 'pt')
    const params = new URLSearchParams();
    if (language) {
        // Extract ISO 639-1 code (2-letter) from language string (e.g., 'en-US' -> 'en', 'it-IT' -> 'it', 'en' -> 'en')
        const iso6391Code = language.split('-')[0].toLowerCase();
        params.append('lang', iso6391Code);
    }
    if (fallbackUrl) {
        params.append('fallback_url', fallbackUrl);
    }
    
    return params.toString() ? `${urlPath}?${params.toString()}` : urlPath;
}

/**
 * Get Top Poster API episode thumbnail URL with rating overlay
 * Format: /{api_key}/{id_type}/thumbnail/{media_id}/S{season}E{episode}.jpg
 * @param {object} ids - Object with tmdbId and/or imdbId
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @param {string} topPosterKey - API key for Top Poster
 * @param {string} resolution - Image resolution (default: 'original')
 * @param {string|null} fallbackUrl - Fallback URL if thumbnail not available
 * @param {object} options - Additional options
 * @param {boolean} options.blur - Whether to request a blurred thumbnail (for spoiler protection)
 */
function getTopPosterThumbnail(config, ids, season, episode, topPosterKey, resolution = 'original', fallbackUrl = null, options = {}) {
    if (!isPosterRatingEnabled(config)) {
        return fallbackUrl;
    }
    const { tmdbId, imdbId } = ids;
    const { blur = false, userAgent = '' } = options;
    let baseUrl = `https://api.top-posters.com`;
    let idType = null;
    let fullMediaId = null;
    
    // Top Poster API supports only IMDb and TMDB for thumbnails
    if (tmdbId) {
        idType = 'tmdb';
        fullMediaId = `series-${tmdbId}`;
    } else if (imdbId) {
        idType = 'imdb';
        fullMediaId = imdbId;
    }
    
    if (!idType || !fullMediaId || !season || !episode) {
        return null;
    }

    // Top Poster API format: /{api_key}/{id_type}/thumbnail/{media_id}/S{season}E{episode}.jpg
    const urlPath = `${baseUrl}/${topPosterKey}/${idType}/thumbnail/${fullMediaId}/S${season}E${episode}.jpg`;
    
    // Build query parameters
    const params = new URLSearchParams();
    if (fallbackUrl) {
        params.append('fallback_url', fallbackUrl);
    }
    if (blur) {
        params.append('blur', 'true');
    }
    if (userAgent) {
      params.append('user_agent', userAgent);
    }

    return params.toString() ? `${urlPath}?${params.toString()}` : urlPath;
}

async function checkIfExists(url) {
  try {
    const response = await axios.head(url, {
      maxRedirects: 5, 
      validateStatus: (status) => status >= 200 && status < 300, 
      timeout: 3000, 
      headers: { 'User-Agent': `AIOMetadata/${buildInfo.version}` }
    });
    
    // Additional robustness checks
    const contentType = response.headers['content-type'];
    const contentLength = response.headers['content-length'];
    
    // Must be an image
    if (contentType && !contentType.startsWith('image/')) {
        return false;
    }
    
    if (contentLength && parseInt(contentLength) < 100) {
        return false;
    }

    return true;
  } catch (error) {
    if (error.response?.status === 404) {
        return false;
    }
    return false;
  }
}

async function parsePoster(type, ids, fallbackFullUrl, language, rpdbkey) {
  if (rpdbkey) {
    const rpdbImage = getRpdbPoster(type, ids, language, rpdbkey);
    if (rpdbImage && await checkIfExists(rpdbImage)) {
      return rpdbImage;
    }
  }
  return fallbackFullUrl;
}

async function parsePosterWithProvider(type, ids, fallbackFullUrl, language, config) {
  if (!isPosterRatingEnabled(config)) {
    return fallbackFullUrl;
  }
  
  // Pass fallback URL to Top Poster API so it can handle errors gracefully
  const posterUrl = getRatingPosterUrl(type, ids, language, config, fallbackFullUrl);
  if (posterUrl && await checkIfExists(posterUrl)) {
    return posterUrl;
  }
  return fallbackFullUrl;
}

// Helper to resolve art provider for specific art type, using meta provider if artProvider is 'meta'
function resolveArtProvider(contentType, artType, config) {
  const artProviderConfig = config.artProviders?.[contentType];
  
  // Handle legacy string format
  if (typeof artProviderConfig === 'string') {
    if (artProviderConfig === 'meta' || !artProviderConfig) {
      return config.providers?.[contentType] || getDefaultProvider(contentType);
    }
    return artProviderConfig;
  }
  
  // Handle new nested object format
  if (typeof artProviderConfig === 'object' && artProviderConfig !== null) {
    const provider = artProviderConfig[artType];
    if (provider === 'meta' || !provider) {
      return config.providers?.[contentType] || getDefaultProvider(contentType);
    }
    return provider;
  }
  
  // Fallback to meta provider
  return config.providers?.[contentType] || getDefaultProvider(contentType);
}

function getDefaultProvider(contentType) {
  switch (contentType) {
    case 'anime': return 'mal';
    case 'movie': return 'tmdb';
    case 'series': return 'tvdb';
    default: return 'tmdb';
  }
}

async function getAnimeBg({ tvdbId, tmdbId, malId, imdbId, malPosterUrl, mediaType = 'series' }, config, isLandscape = false) {
  
  // logger.debug(`[getAnimeBg] Fetching background for ${mediaType} with TVDB ID: ${tvdbId}, TMDB ID: ${tmdbId}, MAL ID: ${malId}`);
  const artProvider = resolveArtProvider('anime', 'background', config);
  const mapping = malId ? idMapper.getMappingByMalId(malId) : null;
  // Check art provider preference
  
  
  if (artProvider === 'anilist' && malId) {
    try {
      const anilistData = await anilist.getAnimeArtwork(malId);
      // logger.debug(`[getAnimeBg] AniList data for MAL ID ${malId}:`, {
      //   hasData: !!anilistData,
      //   hasBannerImage: !!anilistData?.bannerImage,
      //   bannerImage: anilistData?.bannerImage?.substring(0, 50) + '...'
      // });
      
      if (anilistData) {
        const anilistBackground = anilist.getBackgroundUrl(anilistData);
        // logger.debug(`[getAnimeBg] AniList background URL for MAL ID ${malId}:`, anilistBackground?.substring(0, 50) + '...');
        
        if (anilistBackground) {
          // logger.debug(`[getAnimeBg] Found AniList background for MAL ID: ${malId}`);
          return anilistBackground;
        } else {
          // logger.debug(`[getAnimeBg] No AniList background URL found for MAL ID: ${malId}`);
        }
      }
    } catch (error) {
      logger.warn(`[getAnimeBg] AniList background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (artProvider === 'kitsu' && mapping?.kitsu_id && config.providers?.anime !== 'kitsu') {
    try {
      const kitsuData = await kitsu.getMultipleAnimeDetails([mapping.kitsu_id]);
      // logger.debug(`[getAnimeBg] Kitsu data for MAL ID ${malId}:`, {
      //   hasData: !!kitsuData,
      //   hasCoverImage: !!kitsuData?.data?.[0]?.attributes?.coverImage,
      //   coverImage: kitsuData?.data?.[0]?.attributes?.coverImage?.original?.substring(0, 50) + '...'
      // });
      
      if (kitsuData?.data?.[0]?.attributes?.coverImage?.original) {
        // logger.debug(`[getAnimeBg] Found Kitsu background for MAL ID: ${malId} (Kitsu ID: ${mapping.kitsu_id})`);
        return kitsuData.data[0].attributes.coverImage.original;
      } else {
        // logger.debug(`[getAnimeBg] No Kitsu background URL found for MAL ID: ${malId}`);
      }
    } catch (error) {
      logger.warn(`[getAnimeBg] Kitsu background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (artProvider === 'tvdb' && tvdbId) {
    try {
      // Use the appropriate TVDB function based on media type
      const tvdbBackground = mediaType === 'movie'
          ? await tvdb.getMovieBackground(tvdbId, config, isLandscape)
          : await tvdb.getSeriesBackground(tvdbId, config, isLandscape);
        
        if (tvdbBackground) {
          // logger.debug(`[getAnimeBg] Found TVDB background for MAL ID: ${malId} (TVDB ID: ${mapping.tvdb_id}, Type: ${mediaType})`);
          return tvdbBackground;
        }
    } catch (error) {
      logger.warn(`[getAnimeBg] TVDB background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }

  if (artProvider === 'imdb' && imdbId) {
    try {
      return imdb.getBackgroundFromImdb(imdbId);
    } catch (error) {
      logger.warn(`[getAnimeBg] IMDB background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }

  if (artProvider === 'tmdb' && tmdbId) {
    try {
      // Use TMDB background for anime
      const batchArt = mediaType === 'movie' ? await getTmdbMovieArtBatch(tmdbId, config, isLandscape) : await getTmdbSeriesArtBatch(tmdbId, config, isLandscape);
      if (batchArt.background) {
        return batchArt.background;
      }
    } catch (error) {
      logger.warn(`[getAnimeBg] TMDB background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (config.apiKeys.fanart && artProvider === 'fanart') {
    // logger.debug(`[getAnimeBg] Fetching background from Fanart.tv for ${mediaType}`);
    let fanartUrl = null;
    if (mediaType === 'series') {
      if (tvdbId) {
        //console.log(`[getAnimeBg] Found TVDB ID for MAL ID: ${malId} (TVDB ID: ${tvdbId})`);
        fanartUrl = await fanart.getBestSeriesBackground(tvdbId, config);
      }
    } else if (mediaType === 'movie') {
      if (tmdbId) {
        fanartUrl = await fanart.getBestMovieBackground(tmdbId, config);
      } else if (imdbId) {
        fanartUrl = await fanart.getBestMovieBackground(imdbId, config);
      }
    }

    if (fanartUrl) {
      // logger.debug(`[getAnimeBg] Found high-quality Fanart.tv background.`);
      return fanartUrl;
    }
  }

  // logger.debug(`[getAnimeBg] No Fanart or TMDB background found. Falling back to MAL poster.`);
  return malPosterUrl;
}


/**
 * Get anime logo with art provider preference
 */
async function getAnimeLogo({ malId, imdbId, tvdbId, tmdbId, mediaType = 'series' }, config) {
  const artProvider = resolveArtProvider('anime', 'logo', config);
  const mapping = malId ? idMapper.getMappingByMalId(malId) : null;
  tvdbId = tvdbId || mapping?.tvdb_id;
  tmdbId = tmdbId || mapping?.themoviedb_id;
  imdbId = imdbId || mapping?.imdb_id;
  
  if (artProvider === 'tvdb' && tvdbId) {
    try {
      if (tvdbId) {
        // Use the appropriate TVDB function based on media type
        const tvdbLogo = mediaType === 'movie'
          ? await tvdb.getMovieLogo(tvdbId, config)
          : await tvdb.getSeriesLogo(tvdbId, config);
        
        if (tvdbLogo) {
          //console.log(`[getAnimeLogo] Found TVDB logo for MAL ID: ${malId} (TVDB ID: ${tvdbId}, Type: ${mediaType})`);
          return tvdbLogo;
        }
      }
    } catch (error) {
      logger.warn(`[getAnimeLogo] TVDB logo fetch failed for MAL ID ${malId}:`, error.message);
    }
  }

  if (artProvider === 'imdb' && imdbId) {
    try {
      return imdb.getLogoFromImdb(imdbId);
    } catch (error) {
      logger.warn(`[getAnimeLogo] IMDB logo fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  if (artProvider === 'tmdb' && tmdbId) {
    try {
      // Use TMDB logo for anime
      const tmdbLogo = mediaType === 'movie' 
          ? await tmdb.getTmdbMovieLogo(tmdbId, config)
          : await tmdb.getTmdbSeriesLogo(tmdbId, config);
        
        if (tmdbLogo) {
          return tmdbLogo;
        }
    } catch (error) {
      logger.warn(`[getAnimeLogo] TMDB logo fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  // fallback to fanart
  if (config.apiKeys.fanart && artProvider === 'fanart') {
    let fanartUrl = null;
    if (mediaType === 'series' && tvdbId) {
      fanartUrl = await fanart.getBestTVLogo(tvdbId, config);
    } else if (mediaType === 'movie' && tmdbId) {
      fanartUrl = await fanart.getBestMovieLogo(tmdbId, config);
    }
    if (fanartUrl) {
      // logger.debug(`[getAnimeLogo] Found high-quality back up logo from Fanart.tv.`);
      return fanartUrl;
    }
  }
  return null;
}

/**
 * Get anime poster with art provider preference
 */
async function getAnimePoster({ malId, imdbId, tvdbId, tmdbId, malPosterUrl, mediaType = 'series' }, config) {
  const artProvider = resolveArtProvider('anime', 'poster', config);
  const mapping = malId ? idMapper.getMappingByMalId(malId) : null;
  tvdbId = tvdbId || mapping?.tvdb_id;
  tmdbId = tmdbId || mapping?.themoviedb_id;
  imdbId = imdbId || mapping?.imdb_id;
  
  if (artProvider === 'anilist' && malId) {
    try {
      const anilistData = await anilist.getAnimeArtwork(malId);
      if (anilistData) {
        const anilistPoster = anilist.getPosterUrl(anilistData);
        if (anilistPoster) {
          //console.log(`[getAnimePoster] Found AniList poster for MAL ID: ${malId}`);
          return anilistPoster;
        }
      }
    } catch (error) {
      logger.warn(`[getAnimePoster] AniList poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (artProvider === 'kitsu' && malId && mapping?.kitsu_id && config.providers?.anime !== 'kitsu') {
    try {
      const kitsuData = await kitsu.getMultipleAnimeDetails([mapping.kitsu_id]);
      if (kitsuData?.data?.[0]?.attributes?.posterImage?.original) {
        // logger.debug(`[getAnimePoster] Found Kitsu poster for MAL ID: ${malId} (Kitsu ID: ${mapping.kitsu_id})`);
        return kitsuData.data[0].attributes.posterImage.original;
      }
    } catch (error) {
      logger.warn(`[getAnimePoster] Kitsu poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (artProvider === 'tvdb' && tvdbId) {
    try {
      const tvdbPoster = mediaType === 'movie' 
          ? await tvdb.getMoviePoster(tvdbId, config)
          : await tvdb.getSeriesPoster(tvdbId, config);

      if (tvdbPoster) {
        // logger.debug(`[getAnimePoster] Found TVDB poster for MAL ID: ${malId} (TVDB ID: ${tvdbId}, Type: ${mediaType}) - ${tvdbPoster}`);
        return tvdbPoster;
      }
    } catch (error) {
      logger.warn(`[getAnimePoster] TVDB poster fetch failed for ID ${malId || imdbId}:`, error.message);
    }
  }

  if (artProvider === 'imdb' && imdbId) {
    try {
      return imdb.getPosterFromImdb(imdbId);
    } catch (error) {
      logger.warn(`[getAnimePoster] IMDB poster fetch failed for ID ${malId || imdbId}:`, error.message);
    }
  }
  if (artProvider === 'tmdb' && tmdbId) {
    try {
      // Use TMDB poster for anime
        // Use TMDB poster for anime
        const tmdbPoster = mediaType === 'movie' 
          ? await tmdb.getTmdbMoviePoster(tmdbId, config)
          : await tmdb.getTmdbSeriesPoster(tmdbId, config);
        
        if (tmdbPoster) {
          //console.log(`[getAnimePoster] Found TMDB poster for MAL ID: ${malId} (TMDB ID: ${tmdbId}, Type: ${mediaType})`);
          return tmdbPoster;
        }
    } catch (error) {
      logger.warn(`[getAnimePoster] TMDB poster fetch failed for ID ${malId || imdbId}:`, error.message);
    }
  }
  if (config.apiKeys.fanart && artProvider === 'fanart') {
    let fanartUrl = null;
    // logger.debug(`[getAnimePoster] Fetching background for ${mediaType} with TVDB ID: ${tvdbId}, TMDB ID: ${tmdbId}`);
    if (mediaType === 'series' && tvdbId) {
      fanartUrl = await fanart.getBestSeriesPoster(tvdbId, config);
    } else if (mediaType === 'movie' && (imdbId || tmdbId)) {
      fanartUrl = await fanart.getBestMoviePoster(imdbId || tmdbId, config);
    }

    if (fanartUrl) {
      //console.log(`[getAnimePoster] Found high-quality back up poster from Fanart.tv.`);
      return fanartUrl;
    }
  }
  
  return malPosterUrl;
}

/**
 * Get batch anime artwork for catalog usage
 */
async function getBatchAnimeArtwork(malIds, config) {
  const artProvider = resolveArtProvider('anime', 'poster', config);
  
  if (artProvider === 'anilist' && malIds && malIds.length > 0) {
    try {
      const artworkData = await anilist.getCatalogArtwork(malIds);
      // logger.debug(`[getBatchAnimeArtwork] Retrieved ${artworkData.length} AniList artworks for ${malIds.length} MAL IDs`);
      return artworkData;
    } catch (error) {
      logger.warn(`[getBatchAnimeArtwork] AniList batch fetch failed:`, error.message);
    }
  }
  
  if (artProvider === 'kitsu' && malIds && malIds.length > 0) {
    try {
      // Get Kitsu IDs from mappings
      const kitsuIds = malIds
        .map(malId => {
          const mapping = idMapper.getMappingByMalId(malId);
          return mapping?.kitsu_id;
        })
        .filter(id => id);
      
      if (kitsuIds.length > 0) {
        const kitsuData = await kitsu.getMultipleAnimeDetails(kitsuIds);
        // logger.debug(`[getBatchAnimeArtwork] Retrieved ${kitsuData?.data?.length || 0} Kitsu artworks for ${kitsuIds.length} Kitsu IDs`);
        return kitsuData?.data || [];
      }
    } catch (error) {
      logger.warn(`[getBatchAnimeArtwork] Kitsu batch fetch failed:`, error.message);
    }
  }
  
  return [];
}

const KITSU_ANIME_DETAIL_APPENDS = 'categories';

function normalizeKitsuIds(kitsuIds) {
  return [...new Set((kitsuIds || []).map(id => String(id)).filter(Boolean))]
    .sort((a, b) => {
      const numericDiff = Number(a) - Number(b);
      return Number.isNaN(numericDiff) || numericDiff === 0 ? a.localeCompare(b) : numericDiff;
    });
}

function getKitsuBatchDetailsCacheKey(kitsuIds, appends = KITSU_ANIME_DETAIL_APPENDS) {
  const normalizedIds = normalizeKitsuIds(kitsuIds);
  return `kitsu-anime-batch-${normalizedIds.join(',')}-${appends || 'none'}`;
}

async function getCachedKitsuAnimeBatchDetails(kitsuIds, appends = KITSU_ANIME_DETAIL_APPENDS) {
  const normalizedIds = normalizeKitsuIds(kitsuIds);

  if (normalizedIds.length === 0) {
    return { data: [], included: [] };
  }

  return cacheWrapGlobal(
    getKitsuBatchDetailsCacheKey(normalizedIds, appends),
    () => kitsu.getMultipleAnimeDetails(normalizedIds, appends),
    CATALOG_TTL
  );
}

function getKitsuGenresForItem(item, included = [], allowIncludedFallback = false) {
  const categoryIds = (item?.relationships?.categories?.data || []).map(category => String(category.id));

  if (categoryIds.length > 0) {
    const includedCategoriesById = new Map(
      (included || [])
        .filter(includedItem => includedItem.type === 'categories')
        .map(includedItem => [String(includedItem.id), includedItem])
    );

    return categoryIds
      .map(categoryId => includedCategoriesById.get(categoryId)?.attributes?.title)
      .filter(Boolean);
  }

  if (!allowIncludedFallback) return [];

  return (included || [])
    .filter(includedItem => includedItem.type === 'categories')
    .map(includedItem => includedItem.attributes?.title)
    .filter(Boolean);
}

async function parseAnimeCatalogMeta(anime, config, language, descriptionFallback = null) {
  if (!anime || !anime.mal_id) return null;

  const malId = anime.mal_id;
  let stremioType = anime.type?.toLowerCase() === 'movie' ? 'movie' : 'series';
  // ONAs can be movies or series — resolve via Trakt/TMDB
  if (anime.type?.toLowerCase() === 'ona') {
    stremioType = await idMapper.resolveOnaType(malId, config);
  }
  const preferredProvider = config.providers?.anime || 'mal';

  const mapping = idMapper.getMappingByMalId(malId);
  let id = `mal:${malId}`;
  if (preferredProvider === 'tvdb') {
    if (mapping && mapping.tvdb_id) {
      id= `tvdb:${mapping.tvdb_id}`;
    }
  } else if (preferredProvider === 'tmdb') {
    if (mapping && mapping.themoviedb_id) {
      id = `tmdb:${mapping.themoviedb_id}`;
    }
  } else if (preferredProvider === 'imdb') {
    if (mapping && mapping.imdb_id) {
      id= `${mapping.imdb_id}`;
    }
  } 
  
  const malPosterUrl = anime.images?.jpg?.large_image_url;
  let finalPosterUrl = malPosterUrl || `${host}/missing_poster.png`;
  
  // Check art provider preference
  const artProvider = resolveArtProvider('anime', 'poster', config);
  if (artProvider === 'anilist' && malId) {
    try {
      const anilistData = await anilist.getAnimeArtwork(malId);
      if (anilistData) {
        const anilistPoster = anilist.getPosterUrl(anilistData);
        if (anilistPoster) {
          // logger.debug(`[parseAnimeCatalogMeta] Using AniList poster for MAL ID: ${malId}`);
          finalPosterUrl = anilistPoster;
        }
      }
    } catch (error) {
      logger.warn(`[parseAnimeCatalogMeta] AniList poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  } else if (artProvider === 'tvdb' && malId) {
    try {
      const mapping = idMapper.getMappingByMalId(malId);
      if (mapping && mapping.tvdb_id) {
        // Use the appropriate TVDB function based on media type
        const tvdbPoster = stremioType === 'movie'
          ? await tvdb.getMoviePoster(mapping.tvdb_id, config)
          : await tvdb.getSeriesPoster(mapping.tvdb_id, config);
        
        if (tvdbPoster) {
          // logger.debug(`[parseAnimeCatalogMeta] Using TVDB poster for MAL ID: ${malId} (TVDB ID: ${mapping.tvdb_id}, Type: ${stremioType})`);
          finalPosterUrl = tvdbPoster;
        }
      }
    } catch (error) {
      logger.warn(`[parseAnimeCatalogMeta] TVDB poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  } else if (artProvider === 'tmdb' && malId) {
    try {
      const mapping = idMapper.getMappingByMalId(malId);
      if (mapping && mapping.themoviedb_id) {
        // Use TMDB poster for anime
        const tmdbPoster = stremioType === 'movie' 
          ? await tmdb.getTmdbMoviePoster(mapping.themoviedb_id, config)
          : await tmdb.getTmdbSeriesPoster(mapping.themoviedb_id, config);
        
        if (tmdbPoster) {
          // logger.debug(`[parseAnimeCatalogMeta] Using TMDB poster for MAL ID: ${malId} (TMDB ID: ${mapping.themoviedb_id}, Type: ${stremioType})`);
          finalPosterUrl = tmdbPoster;
        }
      }
    } catch (error) {
      logger.warn(`[parseAnimeCatalogMeta] TMDB poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  //const kitsuId = mapping?.kitsu_id;
  const imdbId = mapping?.imdb_id;
  const tmdbId = mapping?.themoviedb_id;
  const kitsuId = mapping?.kitsu_id;
  const imdbRating = await getImdbRating(imdbId, stremioType);
  //const metaType = (kitsuId || imdbId) ? stremioType : 'anime';
  // Check if poster rating is enabled (RPDB or Top Poster API)
  if (isPosterRatingEnabled(config)) {

    if (mapping) {
      const tvdbId = mapping.tvdb_id;
      const tmdbId = mapping.themoviedb_id;
      let proxyId = null;

      if (stremioType === 'series') {
        proxyId = tvdbId ? `tvdb:${tvdbId}` : (tmdbId ? `tmdb:${tmdbId}` : null);
      } else if (stremioType === 'movie') {
        proxyId = tmdbId ? `tmdb:${tmdbId}` : null;
      }

      if (proxyId) {
        finalPosterUrl = buildPosterProxyUrl(host, stremioType, proxyId, finalPosterUrl, language, config);
      }
    }
  }
  const trailerStreams = [];
  if (anime.trailer?.youtube_id) {
    trailerStreams.push({
      ytId: anime.trailer.youtube_id,
      title: anime.title_english || anime.title
    });
  }
  const trailers = [];
  if (anime.trailer?.youtube_id) {
    trailers.push({
      source: anime.trailer.youtube_id,
      type: "Trailer",
      name: anime.title_english || anime.title
    });
  }
  return {
    id:  `mal:${malId}`,
    type: stremioType,
    logo: stremioType === 'movie' ? await tmdb.getTmdbMovieLogo(tmdbId, config) : await tmdb.getTmdbSeriesLogo(tmdbId, config),
    name: anime.title_english || anime.title,
    poster: finalPosterUrl,
    description: descriptionFallback || addMetaProviderAttribution(anime.synopsis, 'MAL', config),
    year: anime.year,
    imdb_id: mapping?.imdb_id,
    releaseInfo: anime.year,
    imdbRating: imdbRating,
    runtime: parseRunTime(anime.duration),
    isAnime: true,
    trailers: trailers,
    trailerStreams: trailerStreams,
    behavioralHints: {
      defaultVideoId: stremioType === 'movie' ? mapping?.imdb_id ? mapping?.imdb_id: (kitsuId ? `kitsu:${kitsuId}` : `mal:${malId}`): null,
      hasScheduledVideos: stremioType === 'series',
    },
  };
}

/**
 * Batch version of parseAnimeCatalogMeta that uses AniList batch fetching for better performance
 */
async function parseAnimeCatalogMetaBatch(animes, config, language, includeVideos = false) {
  if (!animes || animes.length === 0) return [];

  const artProvider = resolveArtProvider('anime', 'poster', config);
  const useAniList = artProvider === 'anilist';
  const useKitsu = artProvider === 'kitsu';
  const useTvdb = artProvider === 'tvdb';
  const useImdb = artProvider === 'imdb';
  const useTmdb = artProvider === 'tmdb';
  const useFanart = (artProvider === 'fanart' && !!config.apiKeys?.fanart);
  //console.log(`[parseAnimeCatalogMetaBatch] Art provider: ${artProvider}, useAniList: ${useAniList}, useTvdb: ${useTvdb}, useTmdb: ${useTmdb}`);
  
  // Extract MAL IDs and try to get AniList IDs from mappings
  const malIds = animes.map(anime => anime.mal_id).filter(id => id && typeof id === 'number' && id > 0);
  const animeByMalId = new Map();
  const mappingByMalId = new Map();
  const kitsuIds = [];
  const seenKitsuIds = new Set();

  animes.forEach(anime => {
    if (!anime || !anime.mal_id || typeof anime.mal_id !== 'number' || anime.mal_id <= 0) return;

    if (!animeByMalId.has(anime.mal_id)) {
      animeByMalId.set(anime.mal_id, anime);
    }

    const mapping = idMapper.getMappingByMalId(anime.mal_id);
    mappingByMalId.set(anime.mal_id, mapping);

    if (mapping?.kitsu_id) {
      const kitsuId = String(mapping.kitsu_id);
      if (!seenKitsuIds.has(kitsuId)) {
        seenKitsuIds.add(kitsuId);
        kitsuIds.push(mapping.kitsu_id);
      }
    }
  });

  let anilistArtworkMap = new Map();
  
  if (useAniList && malIds.length > 0) {
    try {
      //console.log(`[parseAnimeCatalogMetaBatch] Fetching AniList artwork for ${malIds.length} anime in batch`);
      //console.log(`[parseAnimeCatalogMetaBatch] MAL IDs: ${malIds.slice(0, 10).join(', ')}${malIds.length > 10 ? '...' : ''}`);
      
      // First, try to get AniList IDs from mappings
      const anilistIds = [];
      const malIdsWithoutAnilist = [];
      
      malIds.forEach(malId => {
        const mapping = mappingByMalId.get(malId);
        if (mapping && mapping.anilist_id) {
          anilistIds.push(mapping.anilist_id);
        } else {
          malIdsWithoutAnilist.push(malId);
        }
      });
      
      //console.log(`[parseAnimeCatalogMetaBatch] Found ${anilistIds.length} AniList IDs, ${malIdsWithoutAnilist.length} MAL IDs without AniList mapping`);
      
      let anilistArtwork = [];
      
      // Batch fetch using AniList IDs if we have them
      if (anilistIds.length > 0) {
        //console.log(`[parseAnimeCatalogMetaBatch] Fetching via AniList IDs: ${anilistIds.slice(0, 10).join(', ')}${anilistIds.length > 10 ? '...' : ''}`);
        const anilistResults = await anilist.getBatchAnimeArtworkByAnilistIds(anilistIds);
        anilistArtwork.push(...anilistResults);
      }
      
      // Fallback to MAL IDs for those without AniList mappings
      if (malIdsWithoutAnilist.length > 0) {
        //console.log(`[parseAnimeCatalogMetaBatch] Fallback to MAL IDs: ${malIdsWithoutAnilist.slice(0, 10).join(', ')}${malIdsWithoutAnilist.length > 10 ? '...' : ''}`);
        const malResults = await anilist.getBatchAnimeArtwork(malIdsWithoutAnilist, config);
        anilistArtwork.push(...malResults);
      }
      
      // Create a map for quick lookup - use idMal since that's what both methods return
      anilistArtworkMap = new Map(
        anilistArtwork.map(artwork => [artwork.idMal, artwork])
      );
      //console.log(`[parseAnimeCatalogMetaBatch] Successfully fetched ${anilistArtwork.length} AniList artworks`);
      //console.log(`[parseAnimeCatalogMetaBatch] AniList map keys: ${Array.from(anilistArtworkMap.keys()).slice(0, 5).join(', ')}...`);
      /*console.log(`[parseAnimeCatalogMetaBatch] Sample AniList data:`, anilistArtwork[0] ? {
        malId: anilistArtwork[0].idMal,
        id: anilistArtwork[0].id,
        title: anilistArtwork[0].title?.english || anilistArtwork[0].title?.romaji
      } : 'No data');*/
    } catch (error) {
      logger.warn(`[parseAnimeCatalogMetaBatch] AniList batch fetch failed:`, error.message);
    }
  }
  
  // Fetch Kitsu artwork if configured as art provider
  let kitsuArtworkMap = new Map();
  let kitsuBatchDetails = null;
  if (useKitsu && kitsuIds.length > 0) {
    try {
      kitsuBatchDetails = await getCachedKitsuAnimeBatchDetails(kitsuIds);
      if (kitsuBatchDetails?.data) {
        // Create a map for quick lookup using MAL ID as key
        kitsuArtworkMap = new Map();
        kitsuBatchDetails.data.forEach(item => {
          const mapping = idMapper.getMappingByKitsuId(item.id);
          if (mapping?.mal_id) {
            kitsuArtworkMap.set(mapping.mal_id, item);
          }
        });
        // logger.debug(`[parseAnimeCatalogMetaBatch] Successfully fetched ${kitsuBatchDetails.data.length} Kitsu artworks`);
      }
    } catch (error) {
      logger.warn(`[parseAnimeCatalogMetaBatch] Kitsu batch fetch failed:`, error.message);
    }
  }
  
  const preferredProvider = config.providers?.anime || 'mal';
  // logger.debug(`[parseAnimeCatalogMetaBatch] Preferred provider: ${preferredProvider}`);

  if(preferredProvider === 'kitsu') {
    try {
      const kitsuData = kitsuBatchDetails || await getCachedKitsuAnimeBatchDetails(kitsuIds);
      const kitsuItems = kitsuData?.data || [];
      const kitsuById = new Map(kitsuItems.map(item => [String(item.id), item]));

      let metas = await Promise.all(malIds.map(async id => {
        // logger.debug(`[parseAnimeCatalogMetaBatch] Fetching Kitsu data for ID: ${id}`);
        
        const mapping = mappingByMalId.get(id);
        if(!mapping || !mapping.kitsu_id) return parseAnimeCatalogMeta(animeByMalId.get(id), config, language);
        const item = kitsuById.get(String(mapping.kitsu_id));
        if (!item) {
          throw new Error(`Missing Kitsu data for Kitsu ID ${mapping.kitsu_id}`);
        }
        const stremioType = item.attributes.subtype === 'movie' ? 'movie' : 'series';
        let tmdbId = stremioType === 'movie' ? idMapper.getTraktAnimeMovieByMalId(id)?.externals.tmdb : mapping?.themoviedb_id;
        let imdbId = stremioType === 'movie' ? idMapper.getTraktAnimeMovieByMalId(id)?.externals.imdb : mapping?.imdb_id;
        let tvdbId = stremioType === 'movie' ? (wikiMappings.getByImdbId(imdbId, stremioType))?.tvdbId || null : mapping?.tvdb_id;
        let finalPosterUrl = await getAnimePosterUrl(id, mapping, stremioType, config, language, anilistArtworkMap, item.attributes.posterImage?.original, kitsuArtworkMap);
        let kitsuReleaseInfo = item.attributes.startDate ? item.attributes.startDate.substring(0, 4) : null;
        if (stremioType === 'series' && item.attributes.startDate) {
          const firstYear = item.attributes.startDate ? item.attributes.startDate.substring(0, 4) : "";
          if (firstYear) {
            const isOngoing = item.attributes.status === 'current' || !item.attributes.endDate;
            
            if (isOngoing) {
              kitsuReleaseInfo = `${firstYear}-`;
            } else if (item.attributes.endDate) {
              const lastYear = item.attributes.endDate.substring(0, 4);
              kitsuReleaseInfo = firstYear === lastYear ? firstYear : `${firstYear}-${lastYear}`;
            }
          }
        }
        let genres = getKitsuGenresForItem(item, kitsuData?.included, kitsuItems.length <= 1);
        
        let releaseDates = null;
        if (config.hideUnreleasedDigital && stremioType === 'movie' && tmdbId) {
          try {
            releaseDates = await tmdb.getMovieCertifications({ id: tmdbId }, config);
          } catch (error) {
          }
        }
        
        const meta = {
          id: `kitsu:${item.id}`,
          type: stremioType,
          name: getKitsuLocalizedTitle(item.attributes.titles, language) || item.attributes.canonicalTitle,
          background: await getAnimeBg({malId: id, imdbId: imdbId, tvdbId: tvdbId, tmdbId: tmdbId, mediaType: stremioType, malPosterUrl: item.attributes.coverImage?.original}, config),
          logo: await getAnimeLogo({malId: id, imdbId: imdbId, tvdbId: tvdbId, tmdbId: tmdbId, mediaType: stremioType}, config),
          poster: finalPosterUrl,
          description: addMetaProviderAttribution(item.attributes.synopsis, 'KITSU', config),
          year: item.attributes.startDate ? item.attributes.startDate.substring(0, 4) : null,
          imdb_id: imdbId,
          genres: genres,
          releaseInfo: kitsuReleaseInfo,
          runtime: parseRunTime(item.attributes.episodeLength),
          certification: item.attributes.ageRating,
          imdbRating: mapping?.imdb_id ? await getImdbRating(mapping?.imdb_id, stremioType) : 'N/A',
          trailers: item.attributes.youtubeVideoId ? [{
            source: item.attributes.youtubeVideoId,
            type: "Trailer"
          }] : [],
        };
        
        if (releaseDates) {
          meta.app_extras = { releaseDates };
        }
        
        return meta;
      }));
      // Filter out null metas before further processing
      metas = metas.filter(Boolean);
      if(config.ageRating.toLowerCase() !== 'none') {
        // Map user ratings to Kitsu ratings
        const KITSU_RATING_MAP = {
          'G': 'G',
          'PG': 'PG',
          'PG-13': 'PG-13',  
          'R': 'R',
          'NC-17': 'R18',  // Kitsu doesn't have NC-17, map to R18
          'NONE': 'none'
        };
        
        // Define age rating hierarchy (from most restrictive to least restrictive)
        const AGE_RATING_LEVELS = {
          'G': 1,
          'PG': 2,
          'PG-13': 3,
          'R': 4,
          'R18': 5
        };
        
        const userKitsuRating = KITSU_RATING_MAP[config.ageRating.toUpperCase()];
        const userRatingLevel = AGE_RATING_LEVELS[userKitsuRating] || 5;
        
        metas = metas.filter(meta => {
          // If certification is null/undefined, don't filter out the anime
          if (!meta.certification) return true;
          
          const metaRatingLevel = AGE_RATING_LEVELS[meta.certification] || 5;
          // Only show content that is at or below the user's preferred rating level
          return metaRatingLevel <= userRatingLevel;
        });
      }
      return metas;
    } catch (error) {
      logger.warn(`[parseAnimeCatalogMetaBatch] Kitsu batch fetch failed:`, error.message);
    }
  }
  // Process each anime
  const results = await Promise.all(animes.map(async anime => {
    if (!anime || !anime.mal_id) return null;

    const malId = anime.mal_id;
    let stremioType = anime.type?.toLowerCase() === 'movie' ? 'movie' : 'series';
    // ONAs can be movies or series — resolve via Trakt/TMDB
    if (anime.type?.toLowerCase() === 'ona') {
      stremioType = await idMapper.resolveOnaType(malId, config);
    }

    const mapping = idMapper.getMappingByMalId(malId);
    let tmdbId = stremioType === 'movie' ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals.tmdb : mapping?.themoviedb_id;
    let imdbId = stremioType === 'movie' ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals.imdb : mapping?.imdb_id;
    let tvdbId = stremioType === 'movie' ? (wikiMappings.getByImdbId(imdbId, stremioType))?.tvdbId || null : mapping?.tvdb_id;
    
    /*if(mapping && !mapping.imdb_id && mapping.themoviedb_id){
      const allIds = await resolveAllIds(mapping.themoviedb_id, stremioType, config, {}, ['imdb']);
      mapping.imdb_id = allIds?.imdbId;
    }*/
    let id = `mal:${malId}`;
    if (preferredProvider === 'tvdb') {
      if (imdbId) {
        id= `${imdbId}`;
      }
    } else if (preferredProvider === 'tmdb') {
      if (imdbId) {
        id = `${imdbId}`;
      }
    } else if (preferredProvider === 'imdb') {
      if (imdbId) {
        id= `${imdbId}`;
      }
    } else if (preferredProvider === 'kitsu') {
      if (mapping && mapping.kitsu_id) {
        id = `kitsu:${mapping.kitsu_id}`;
      }
    }

    const malPosterUrl = anime.images?.jpg?.large_image_url;
    
    // Phase 1: Parallel fetch for always-needed data (poster + rating)
    const [finalPosterUrl, imdbRating] = await Promise.all([
      getAnimePosterUrl(malId, mapping, stremioType, config, language, anilistArtworkMap, anime.images?.jpg?.large_image_url, kitsuArtworkMap),
      getImdbRating(imdbId, stremioType)
    ]);
    
    const trailerStreams = [];
    if (anime.trailer?.youtube_id) {
      trailerStreams.push({
        ytId: anime.trailer.youtube_id,
        title: anime.title_english || anime.title
      });
    }
    const trailers = [];
    if (anime.trailer?.youtube_id) {
      trailers.push({
        source: anime.trailer.youtube_id,
        type: "Trailer",
        name: anime.title_english || anime.title
      });
    }
    if((config.mal?.useImdbIdForCatalogAndSearch && imdbId)){
      return (await cacheWrapMetaSmart(config.userUUID, id, async () => {
        const { getMeta } = await import("../lib/getMeta");
        // When useImdbIdForCatalogAndSearch is enabled, call getMeta with IMDb ID so it's treated consistently
        // This ensures cache keys match - if forceAnimeForDetectedImdb is false, it will be treated as series/movie
        return await getMeta(stremioType, language, id, config, config.userUUID, includeVideos);
      }, undefined, {enableErrorCaching: true, maxRetries: 2, config}, stremioType, includeVideos))?.meta || null;
    }
    else {
      let malReleaseInfo = anime.year || (anime.aired?.from ? anime.aired.from.substring(0, 4) : "");
      if (stremioType === 'series' && anime.aired) {
        const firstYear = anime.aired.from ? anime.aired.from.substring(0, 4) : "";
        if (firstYear) {
          const isOngoing = anime.status === 'Currently Airing' || !anime.aired.to;
          
          if (isOngoing) {
            malReleaseInfo = `${firstYear}-`;
          } else if (anime.aired.to) {
            const lastYear = anime.aired.to.substring(0, 4);
            malReleaseInfo = firstYear === lastYear ? firstYear : `${firstYear}-${lastYear}`;
          }
        }
      }
      // Only fetch TMDB release dates if digital release filter is enabled and it's a movie with TMDB ID
      let releaseDates = null;
      const shouldFetchReleaseDates = config.hideUnreleasedDigital && stremioType === 'movie' && tmdbId;
      
      const [logo, background, releaseDatesResult] = await Promise.all([
        getAnimeLogo({malId, imdbId, tvdbId, tmdbId, mediaType: stremioType}, config),
        getAnimeBg({malId, imdbId, tvdbId, tmdbId, mediaType: stremioType, malPosterUrl}, config),
        shouldFetchReleaseDates 
          ? tmdb.getMovieCertifications({ id: tmdbId }, config).then(data => data || null).catch(() => null)
          : Promise.resolve(null)
      ]);
      
      if (releaseDatesResult) {
        releaseDates = releaseDatesResult;
      }
      
      const meta = {
        id: `mal:${malId}`,
        type: stremioType,
        logo: logo,
        background: background,
        name: anime.title_english || anime.title,
        poster: finalPosterUrl,
        description: addMetaProviderAttribution(anime.synopsis, 'MAL', config),
        year: anime.year,
        imdb_id: imdbId,
        releaseInfo: malReleaseInfo,
        runtime: parseRunTime(anime.duration),
        imdbRating: imdbRating,
        trailers: trailers,
        trailerStreams: trailerStreams
      };
      
      if (releaseDates) {
        meta.app_extras = { releaseDates };
      }
      
      return meta;
    }
  }));
  
  return results.filter(Boolean);
}

/**
 * Parses a YouTube URL and extracts the video ID (the 'v' parameter).
 * @param {string} url - The full YouTube URL.
 * @returns {string|null} The YouTube video ID, or null if not found.
 */
function getYouTubeIdFromUrl(url) {
  if (!url) return null;
  try {
    const urlObject = new URL(url);
    // Standard YouTube URLs have the ID in the 'v' query parameter.
    if (urlObject.hostname === 'www.youtube.com' || urlObject.hostname === 'youtube.com') {
      return urlObject.searchParams.get('v');
    }
    // Handle youtu.be short links
    if (urlObject.hostname === 'youtu.be') {
      return urlObject.pathname.slice(1); // Remove the leading '/'
    }
  } catch (error) {
    logger.warn(`[Parser] Could not parse invalid URL for YouTube ID: ${url}`);
  }
  return null;
}

/**
 * Parses the trailers array from the TVDB API into Stremio-compatible formats.
 * @param {Array} tvdbTrailers - The `trailers` array from the TVDB API response.
 * @param {string} defaultTitle - A fallback title to use for the trailer.
 * @returns {{trailers: Array, trailerStreams: Array}} An object containing both formats.
 */
function parseTvdbTrailers(tvdbTrailers, defaultTitle = 'Official Trailer') {
  const trailers = [];
  const trailerStreams = [];

  if (!Array.isArray(tvdbTrailers)) {
    return { trailers, trailerStreams };
  }

  for (const trailer of tvdbTrailers) {
    if (trailer.url && trailer.url.includes('youtube.com') || trailer.url.includes('youtu.be')) {
      const ytId = getYouTubeIdFromUrl(trailer.url);

      if (ytId) {
        const title = trailer.name || defaultTitle;

        trailers.push({
          source: ytId,
          type: 'Trailer',
          name: defaultTitle
        });

        trailerStreams.push({
          ytId: ytId,
          title: title
        });
      }
    }
  }

  return { trailers, trailerStreams };
}

// In-flight request cache for TMDB movie images to deduplicate concurrent requests
const tmdbMovieImagesInflight = new Map();

/**
 * Fetch all TMDB movie art (poster, background, logo) in a single API call.
 * Uses request deduplication to prevent multiple concurrent calls for the same movie.
 * @param {string} tmdbId - The TMDB movie ID
 * @param {object} config - User configuration
 * @returns {Promise<{poster: string|null, background: string|null, logo: string|null}>}
 */
async function getTmdbMovieArtBatch(tmdbId, config, isLandscape = false, originalLanguage = null) {
  if (!tmdbId) return { poster: null, background: null, logo: null };

  const langCode = config.language?.split('-')[0] || 'en';
  const englishOnly = config.artProviders?.englishArtOnly ? '1' : '0';
  const origLangFb = config.artProviders?.originalLangFallback ? '1' : '0';
  const landscape = isLandscape ? '1' : '0';
  const cacheKey = `tmdb-movie-images:${tmdbId}:${langCode}:${englishOnly}:${origLangFb}:${landscape}`;

  if (tmdbMovieImagesInflight.has(cacheKey)) {
    return tmdbMovieImagesInflight.get(cacheKey);
  }
  
  // Create the promise for this request
  const fetchPromise = (async () => {
    try {
      const langSet = new Set([langCode, 'en', 'null']);
      if (originalLanguage) langSet.add(originalLanguage);
      const imageLanguages = Array.from(langSet).join(',');
      const res = await tmdb.movieImages({ id: tmdbId, include_image_language: imageLanguages }, config);

      if (!res) {
        return { poster: null, background: null, logo: null };
      }

      const posterImg = selectTmdbImageByLang(res.posters, config, 'iso_639_1', originalLanguage);
      const poster = posterImg?.file_path
        ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${posterImg.file_path}`
        : null;
      let backgroundImg;
      if (isLandscape) {
        backgroundImg = selectTmdbImageByLang(res.backdrops, config, 'iso_639_1', originalLanguage);
      }
      else {
      backgroundImg = res.backdrops?.find(b => b.iso_639_1 === 'xx')
      || res.backdrops?.find(b => b.iso_639_1 === null)
      || res.backdrops?.find(b => b.iso_639_1 === langCode)
      || res.backdrops?.[0];
      }
      const background = backgroundImg?.file_path
        ? `https://image.tmdb.org/t/p/original${backgroundImg.file_path}`
        : null;

      const logoImg = selectTmdbImageByLang(res.logos, config, 'iso_639_1', originalLanguage);
      const logo = logoImg?.file_path
        ? `https://image.tmdb.org/t/p/original${logoImg.file_path}`
        : null;

      return { poster, background, logo };
    } catch (error) {
      logger.warn(`[getTmdbMovieArtBatch] Failed to fetch TMDB images for movie ${tmdbId}:`, error.message);
      return { poster: null, background: null, logo: null };
    } finally {
      // Clean up the in-flight cache after a short delay to handle near-simultaneous requests
      setTimeout(() => tmdbMovieImagesInflight.delete(cacheKey), 100);
    }
  })();
  
  // Store the promise in the in-flight cache
  tmdbMovieImagesInflight.set(cacheKey, fetchPromise);
  
  return fetchPromise;
}

/**
 * Get movie poster with art provider preference
 */
async function getMoviePoster({ tmdbId, tvdbId, imdbId, metaProvider, fallbackPosterUrl, originalLanguage }, config, isLandscape = false) {
  const artProvider = resolveArtProvider('movie', 'poster', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
      const tvdbPoster = await tvdb.getMoviePoster(tvdbId, config, isLandscape);
      if (tvdbPoster) {
        // logger.debug(`[getMoviePoster] Found TVDB poster for movie (TVDB ID: ${tvdbId})`);
          return tvdbPoster;
        }
      }
      else {
        if(!tmdbId) return fallbackPosterUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'movie', config);
        if(mappedIds.tvdbId) {
          const tvdbPoster = await tvdb.getMoviePoster(mappedIds.tvdbId, config, isLandscape);
          // logger.debug(`[getMoviePoster] Found TVDB poster via ID mapping for movie (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbPoster;
        }
      }
    } catch (error) {
      logger.warn(`[getMoviePoster] TVDB poster fetch failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const poster = await fanart.getBestMoviePoster(tmdbId, config);
        if (poster) {
          // logger.debug(`[getMoviePoster] Found Fanart.tv poster for movie (TMDB ID: ${tmdbId})`);
          return poster;
        }
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const poster = await fanart.getBestMoviePoster(mappedIds.tmdbId, config);
          if (poster) {
            // logger.debug(`[getMoviePoster] Found Fanart.tv poster via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return poster;
          }
        }
      }
    } catch (error) {
      logger.warn(`[getMoviePoster] Fanart.tv poster fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const batchArt = await getTmdbMovieArtBatch(tmdbId, config, isLandscape, originalLanguage);
        if (batchArt.poster) {
          return batchArt.poster;
        }
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const batchArt = await getTmdbMovieArtBatch(mappedIds.tmdbId, config, isLandscape, originalLanguage);
          if (batchArt.poster) {
            return batchArt.poster;
          }
        }
      }
    } catch (error) {
      logger.warn(`[getMoviePoster] TMDB poster fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  else if (artProvider === 'imdb' && metaProvider != 'imdb') {
    if(imdbId) {
      return imdb.getPosterFromImdb(imdbId);
    } else if(tvdbId) {
      const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
      if (mappedIds.imdbId) {
        return imdb.getPosterFromImdb(mappedIds.imdbId);
      }
    }
  }

  return fallbackPosterUrl;
}

/**
 * Get movie background with art provider preference
 */
async function getMovieBackground({ tmdbId, tvdbId, imdbId, metaProvider, fallbackBackgroundUrl, originalLanguage }, config) {
  const artProvider = resolveArtProvider('movie', 'background', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        // logger.debug(`[getMovieBackground] Fetching TVDB background for movie (TVDB ID: ${tvdbId})`);
        const tvdbBackground = await tvdb.getMovieBackground(tvdbId, config);
        if (tvdbBackground) {
          // logger.debug(`[getMovieBackground] Found TVDB background for movie (TVDB ID: ${tvdbId}): ${tvdbBackground.substring(0, 50)}...`);
          return tvdbBackground;
        }
      }
      else {
        if(!tmdbId) return fallbackBackgroundUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'movie', config);
        if(mappedIds.tvdbId) {
          const tvdbBackground = await tvdb.getMovieBackground(mappedIds.tvdbId, config);
          // logger.debug(`[getMovieBackground] Found TVDB background via ID mapping for movie (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbBackground;
        }
      }
    } catch (error) {
      logger.warn(`[getMovieBackground] TVDB background fetch failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const bg = await fanart.getBestMovieBackground(tmdbId, config);
        if (bg) {
          // logger.debug(`[getMovieBackground] Found Fanart.tv background for movie (TMDB ID: ${tmdbId})`);
          return bg;
        }
      }
      else {
        if(!tvdbId) return fallbackBackgroundUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const bg = await fanart.getBestMovieBackground(mappedIds.tmdbId, config);
          if (bg) {
            // logger.debug(`[getMovieBackground] Found Fanart.tv background via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return bg;
          }
        }
      }
    } catch (error) {
      logger.warn(`[getMovieBackground] Fanart.tv background fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const batchArt = await getTmdbMovieArtBatch(tmdbId, config, false, originalLanguage);
        if (batchArt.background) {
          return batchArt.background;
        }
      }
      else {
        if(!tvdbId) return fallbackBackgroundUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const batchArt = await getTmdbMovieArtBatch(mappedIds.tmdbId, config, false, originalLanguage);
          if (batchArt.background) {
            return batchArt.background;
          }
        }
      }
    } catch (error) {
      logger.warn(`[getMovieBackground] TMDB background fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  else if (artProvider === 'imdb' && metaProvider != 'imdb') {
    if(imdbId) {
      return imdb.getBackgroundFromImdb(imdbId);
    }
  }
  return fallbackBackgroundUrl;
}

/**
 * Get movie logo with art provider preference
 */
async function getMovieLogo({ tmdbId, tvdbId, imdbId, metaProvider, fallbackLogoUrl, originalLanguage }, config) {
  const artProvider = resolveArtProvider('movie', 'logo', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        const tvdbLogo = await tvdb.getMovieLogo(tvdbId, config);
        if (tvdbLogo) {
          // logger.debug(`[getMovieLogo] Found TVDB logo for movie (TVDB ID: ${tvdbId})`);
          return tvdbLogo;
        }
      }
      else {
        if(!tmdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'movie', config);
        if(mappedIds.tvdbId) {
          const tvdbLogo = await tvdb.getMovieLogo(mappedIds.tvdbId, config);
          // logger.debug(`[getMovieLogo] Found TVDB logo via ID mapping for movie (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbLogo;
        }
      }
    } catch (error) {
      logger.warn(`[getMovieLogo] TVDB logo fetch failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const logo = await fanart.getBestMovieLogo(tmdbId, config);
        if (logo) {
          // logger.debug(`[getMovieLogo] Found Fanart.tv logo for movie (TMDB ID: ${tmdbId})`);
          return logo;
        }
      }
      else {
        if(!tvdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const logo = await fanart.getBestMovieLogo(mappedIds.tmdbId, config);
          if (logo) {
            // logger.debug(`[getMovieLogo] Found Fanart.tv logo via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return logo;
          }
        }
      }
    } catch (error) {
      logger.warn(`[getMovieLogo] Fanart.tv logo fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const batchArt = await getTmdbMovieArtBatch(tmdbId, config, false, originalLanguage);
        if (batchArt.logo) {
          return batchArt.logo;
        }
      }
      else {
        if(!tvdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const batchArt = await getTmdbMovieArtBatch(mappedIds.tmdbId, config, false, originalLanguage);
          if (batchArt.logo) {
            return batchArt.logo;
          }
        }
      }
    } catch (error) {
      logger.warn(`[getMovieLogo] TMDB logo fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  else if (artProvider === 'imdb' && metaProvider != 'imdb') {
    if(imdbId) {
      return imdb.getLogoFromImdb(imdbId);
    } else if(tvdbId) {
      const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
      if(mappedIds.imdbId) {
        return imdb.getLogoFromImdb(mappedIds.imdbId);
      }
    }
  }
  
  return fallbackLogoUrl;
}

// In-flight request cache for TMDB TV images to deduplicate concurrent requests
const tmdbTvImagesInflight = new Map();

/**
 * Fetch all TMDB TV series art (poster, background, logo) in a single API call.
 * Uses request deduplication to prevent multiple concurrent calls for the same series.
 * @param {string} tmdbId - The TMDB TV series ID
 * @param {object} config - User configuration
 * @returns {Promise<{poster: string|null, background: string|null, logo: string|null}>}
 */
async function getTmdbSeriesArtBatch(tmdbId, config, isLandscape = false, originalLanguage = null) {
  if (!tmdbId) return { poster: null, background: null, logo: null };

  const langCode = config.language?.split('-')[0] || 'en';
  const englishOnly = config.artProviders?.englishArtOnly ? '1' : '0';
  const origLangFb = config.artProviders?.originalLangFallback ? '1' : '0';
  const landscape = isLandscape ? '1' : '0';
  const cacheKey = `tmdb-tv-images:${tmdbId}:${langCode}:${englishOnly}:${origLangFb}:${landscape}`;

  if (tmdbTvImagesInflight.has(cacheKey)) {
    return tmdbTvImagesInflight.get(cacheKey);
  }
  
  // Create the promise for this request
  const fetchPromise = (async () => {
    try {
      const langSet = new Set([langCode, 'en', 'null']);
      if (originalLanguage) langSet.add(originalLanguage);
      const imageLanguages = Array.from(langSet).join(',');
      const res = await tmdb.tvImages({ id: tmdbId, include_image_language: imageLanguages }, config);

      if (!res) {
        return { poster: null, background: null, logo: null };
      }

      const posterImg = selectTmdbImageByLang(res.posters, config, 'iso_639_1', originalLanguage);
      const poster = posterImg?.file_path
        ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${posterImg.file_path}`
        : null;

      let backgroundImg;
      if (isLandscape) {
        backgroundImg = selectTmdbImageByLang(res.backdrops, config, 'iso_639_1', originalLanguage);
      }
      else {
      backgroundImg = res.backdrops?.find(b => b.iso_639_1 === 'xx')
        || res.backdrops?.find(b => b.iso_639_1 === null)
        || res.backdrops?.find(b => b.iso_639_1 === langCode)
        || res.backdrops?.[0];
      }
      const background = backgroundImg?.file_path
        ? `https://image.tmdb.org/t/p/original${backgroundImg.file_path}`
        : null;

      const logoImg = selectTmdbImageByLang(res.logos, config, 'iso_639_1', originalLanguage);
      const logo = logoImg?.file_path
        ? `https://image.tmdb.org/t/p/original${logoImg.file_path}`
        : null;

      return { poster, background, logo };
    } catch (error) {
      logger.warn(`[getTmdbSeriesArtBatch] Failed to fetch TMDB images for series ${tmdbId}:`, error.message);
      return { poster: null, background: null, logo: null };
    } finally {
      // Clean up the in-flight cache after a short delay to handle near-simultaneous requests
      setTimeout(() => tmdbTvImagesInflight.delete(cacheKey), 100);
    }
  })();
  
  // Store the promise in the in-flight cache
  tmdbTvImagesInflight.set(cacheKey, fetchPromise);
  
  return fetchPromise;
}

/**
 * Get series poster with art provider preference
 */
async function getSeriesPoster({ tmdbId, tvdbId, imdbId, metaProvider, fallbackPosterUrl, originalLanguage }, config) {
  const artProvider = resolveArtProvider('series', 'poster', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        const tvdbPoster = await tvdb.getSeriesPoster(tvdbId, config);
        if (tvdbPoster) {
          return tvdbPoster;
        }
      }
      else {
        if(!tmdbId) return fallbackPosterUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config, null, ['tvdb']);
        if(mappedIds.tvdbId) {
          const tvdbPoster = await tvdb.getSeriesPoster(mappedIds.tvdbId, config);
          return tvdbPoster;
        }
      }
    } catch (error) {
      logger.warn(`[getSeriesPoster] TVDB poster fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tvdbId) {
        const poster = await fanart.getBestSeriesPoster(tvdbId, config);
        if (poster) {
          return poster;
        }
      }
      else if(tmdbId) {
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config, null, ['tvdb']);
        if(mappedIds.tvdbId) {
          const poster = await fanart.getBestSeriesPoster(mappedIds.tvdbId, config);
          if (poster) {
              return poster;
          }
        }
      }
      
    } catch (error) {
      logger.warn(`[getSeriesPoster] Fanart.tv poster fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const batchArt = await getTmdbSeriesArtBatch(tmdbId, config, false, originalLanguage);
        if (batchArt.poster) {
          return batchArt.poster;
        }
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'series', config, null, ['tmdb']);
        if(mappedIds.tmdbId) {
          const batchArt = await getTmdbSeriesArtBatch(mappedIds.tmdbId, config, false, originalLanguage);
          if (batchArt.poster) {
            return batchArt.poster;
          }
        }
      }
    } catch (error) {
      logger.warn(`[getSeriesPoster] TMDB poster fetch failed for series (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  else if (artProvider === 'imdb' && metaProvider != 'imdb') {
    if(imdbId) {
      return imdb.getPosterFromImdb(imdbId);
    } else if(tvdbId) {
      const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'series', config, null, ['imdb']);
      if(mappedIds.imdbId) {
        return imdb.getPosterFromImdb(mappedIds.imdbId);
      }
    }
  }
  return fallbackPosterUrl;
}

/**
 * Get series background with art provider preference
 */
async function getSeriesBackground({ tmdbId, tvdbId, imdbId, metaProvider, fallbackBackgroundUrl, originalLanguage }, config, isLandscape = false) {
  const artProvider = resolveArtProvider('series', 'background', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
      const tvdbBackground = await tvdb.getSeriesBackground(tvdbId, config, isLandscape);
      if (tvdbBackground) {
        // logger.debug(`[getSeriesBackground] Found TVDB background for series (TVDB ID: ${tvdbId})`);
          return tvdbBackground;
        }
      }
      else {
        if(!tmdbId) return fallbackBackgroundUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config, null, ['tvdb']);
        if(mappedIds.tvdbId) {
          const tvdbBackground = await tvdb.getSeriesBackground(mappedIds.tvdbId, config, isLandscape);
          // logger.debug(`[getSeriesBackground] Found TVDB background via ID mapping for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbBackground;
        }
      }
    } catch (error) {
      logger.warn(`[getSeriesBackground] TVDB background fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tvdbId) {
        const bg = await fanart.getBestSeriesBackground(tvdbId, config);
        if (bg) {
          // logger.debug(`[getSeriesBackground] Found Fanart.tv background for series (TVDB ID: ${tvdbId})`);
          return bg;
        }
      } else if(tmdbId) {
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config);
        if(mappedIds.tvdbId) {
          const bg = await fanart.getBestSeriesBackground(mappedIds.tvdbId, config, isLandscape);
          if (bg) {
            // logger.debug(`[getSeriesBackground] Found Fanart.tv background via ID mapping for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
            return bg;
          }
        }
      }
          
    } catch (error) {
      logger.warn(`[getSeriesBackground] Fanart.tv background fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const batchArt = await getTmdbSeriesArtBatch(tmdbId, config, isLandscape, originalLanguage);
        if (batchArt.background) {
          return batchArt.background;
        }
      }
      else {
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'series', config, null, ['tmdb']);
        if(mappedIds.tmdbId) {
          const batchArt = await getTmdbSeriesArtBatch(mappedIds.tmdbId, config, isLandscape, originalLanguage);
          if (batchArt.background) {
            return batchArt.background;
          }
        }
      }
    } catch (error) {
      logger.warn(`[getSeriesBackground] TMDB background fetch failed for series (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  else if (artProvider === 'imdb' && metaProvider != 'imdb') {
    if(imdbId) {
      return imdb.getBackgroundFromImdb(imdbId);
    }
  }
  // Fallback to meta background
  return fallbackBackgroundUrl;
}

/**
 * Get series logo with art provider preference
 */
async function getSeriesLogo({ tmdbId, tvdbId, imdbId, metaProvider, fallbackLogoUrl, originalLanguage }, config) {
  const artProvider = resolveArtProvider('series', 'logo', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        const tvdbLogo = await tvdb.getSeriesLogo(tvdbId, config);
        if (tvdbLogo) {
        // logger.debug(`[getSeriesLogo] Found TVDB logo for series (TVDB ID: ${tvdbId})`);
          return tvdbLogo;
        }
      }
      else {
        if(!tmdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config, null, ['tvdb']);
        if(mappedIds.tvdbId) {
          const tvdbLogo = await tvdb.getSeriesLogo(mappedIds.tvdbId, config);
          // logger.debug(`[getSeriesLogo] Found TVDB logo via ID mapping for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbLogo;
        }
      }
    } catch (error) {
      logger.warn(`[getSeriesLogo] TVDB logo fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tvdbId) {
        const logo = await fanart.getBestTVLogo(tvdbId, config);
        if (logo) {
          // logger.debug(`[getSeriesLogo] Found Fanart.tv logo for series (TVDB ID: ${tvdbId})`);
          return logo;
        }
      }
      else if(tmdbId) {
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config, null, ['tvdb']);
        if(mappedIds.tvdbId) {
          // logger.debug(`[getSeriesLogo] Fetching Fanart.tv logo for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          const logo = await fanart.getBestTVLogo(mappedIds.tvdbId, config);
          if (logo) {
            // logger.debug(`[getSeriesLogo] Found Fanart.tv logo for series (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tvdbId})`);
            return logo;
          }
        }
      }
      else {
        return fallbackLogoUrl;
      }
    } catch (error) {
      logger.warn(`[getSeriesLogo] Fanart.tv logo fetch failed for series (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const batchArt = await getTmdbSeriesArtBatch(tmdbId, config, false, originalLanguage);
        if (batchArt.logo) {
          return batchArt.logo;
        }
      }
      else {
        if(!tvdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'series', config);
        if(mappedIds.tmdbId) {
          const batchArt = await getTmdbSeriesArtBatch(mappedIds.tmdbId, config, false, originalLanguage);
          if (batchArt.logo) {
            return batchArt.logo;
          }
        }
      }
    } catch (error) {
      logger.warn(`[getSeriesLogo] TMDB logo fetch failed for series (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  else if ((artProvider === 'imdb' || fallbackLogoUrl === null) && metaProvider != 'imdb') {
    if(imdbId) {
      return imdb.getLogoFromImdb(imdbId);
    }
  }
  return fallbackLogoUrl;

}

/**
 * Convert banner image to background image using the image processing API
 * @param {string} bannerUrl - Original banner image URL
 * @param {Object} options - Processing options
 * @param {number} options.width - Target width (default: 1920)
 * @param {number} options.height - Target height (default: 1080)
 * @param {number} options.blur - Blur amount (default: 0)
 * @param {number} options.brightness - Brightness adjustment (default: 1)
 * @param {number} options.contrast - Contrast adjustment (default: 1)
 * @returns {string} Processed background image URL
 */
function convertBannerToBackgroundUrl(bannerUrl, options = {}) {
  if (!bannerUrl) return null;
  
  const {
    width = 1920,
    height = 1080,
    blur = 0,
    brightness = 1,
    contrast = 1
  } = options;

  const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

  // Build the query parameters
  const params = new URLSearchParams({
    url: bannerUrl,
    width: width.toString(),
    height: height.toString(),
    blur: blur.toString(),
    brightness: brightness.toString(),
    contrast: contrast.toString()
  });

  return `${host}/api/image/banner-to-background?${params.toString()}`;
}

/**
 * Smart background image processor that automatically converts banners to backgrounds
 * @param {string} imageUrl - Original image URL
 * @param {string} imageType - Type of image: 'banner', 'poster', 'background'
 * @param {Object} options - Processing options
 * @returns {string} Processed image URL
 */
function processBackgroundImage(imageUrl, imageType = 'background', options = {}) {
  if (!imageUrl) return null;

  // If it's already a background image, return as is
  if (imageType === 'background') {
    return imageUrl;
  }

  // If it's a banner, convert to background
  if (imageType === 'banner') {
    return convertBannerToBackgroundUrl(imageUrl, {
      blur: 2, // Slight blur for better text readability
      brightness: 0.9, // Slightly darker
      ...options
    });
  }

  // If it's a poster, convert to background with more processing
  if (imageType === 'poster') {
    return convertBannerToBackgroundUrl(imageUrl, {
      blur: 3, // More blur for posters
      brightness: 0.8, // Darker for better contrast
      ...options
    });
  }

  return imageUrl;
}

/**
 * Convert AniList banner image to background image
 * @param {string} bannerUrl - AniList banner image URL
 * @param {Object} options - Processing options
 * @returns {string} Processed background image URL
 */
function convertAnilistBannerToBackground(bannerUrl, options = {}) {
  if (!bannerUrl) return null;
  
  return convertBannerToBackgroundUrl(bannerUrl, {
    width: 1920,
    height: 1080,
    blur: 0.5, // Minimal blur to preserve image quality
    brightness: 0.98, // Keep original brightness
    contrast: 1.05, // Very slight contrast boost
    ...options
  });
}

// Helper for language fallback selection from TMDB images
function selectTmdbImageByLang(images, config, key = 'iso_639_1', originalLanguage = null) {
  if (!Array.isArray(images) || images.length === 0) return undefined;

  const targetLang = config.artProviders?.englishArtOnly ? 'en' : (config.language?.split('-')[0]?.toLowerCase() || 'en');
  const targetCountry = config.language?.split('-')[1]?.toUpperCase() || 'US';
  const preferOrigLang = config.artProviders?.originalLangFallback;

  const targetExact = images.find(img => img[key] === targetLang && img.iso_3166_1 === targetCountry);
  if (targetExact) return targetExact;

  if (preferOrigLang) {
    return images.find(img => img[key] === 'en')
      || (originalLanguage && images.find(img => img[key] === originalLanguage))
      || images.find(img => img[key] != null && img[key] !== 'xx')
      || images[0];
  }

  return images.find(img => img[key] === targetLang)
    || images.find(img => img[key] === 'en')
    || (originalLanguage && images.find(img => img[key] === originalLanguage))
    || images.find(img => img[key] != null && img[key] !== 'xx')
    || images[0];
}

function genSeasonsString(seasons) {
  if (seasons.length <= 20) {
    return [
      seasons.map((season) => `season/${season.season_number}`).join(","),
    ];
  } else {
    const result = new Array(Math.ceil(seasons.length / 20))
      .fill()
      .map((_) => seasons.splice(0, 20));
    return result.map((arr) => {
      return arr.map((season) => `season/${season.season_number}`).join(",");
    });
  }
}

/**
 * Check if a movie has been released digitally
 * A movie is considered "released digitally" if:
 * 1. It was released more than 1 year ago (assume digital release available), OR
 * 2. For recent movies (< 1 year), has explicit digital/physical/TV release dates in TMDB data
 * @param meta - The movie meta object
 * @returns true if the movie has been released digitally, false otherwise
 */
function isReleasedDigitally(meta) {
  if (!meta || meta.type !== 'movie') {
    return true; // Only filter movies, not series
  }

  const releaseAvailability = getReleaseAvailability(meta);
  const isOnOrBeforeNow = (dateValue, now) => {
    if (!dateValue) return false;
    const time = new Date(dateValue).getTime();
    return Number.isFinite(time) && time <= now.getTime();
  };

  // Check if movie has a release date
  if (!meta.released) {
    if (releaseAvailability?.hasReleaseDateData) {
      const now = new Date();
      const hasAnyPastRelease = isOnOrBeforeNow(releaseAvailability.earliestAnyReleaseDate, now);
      if (!hasAnyPastRelease) {
        return false; 
      }
      return isOnOrBeforeNow(releaseAvailability.earliestHomeReleaseDate, now);
    }
    return true;
  }

  const releaseDate = new Date(meta.released);
  const now = new Date();
  
  // Check if date is valid
  if (isNaN(releaseDate.getTime())) {
    // Invalid date - keep due to lack of data
    return true;
  }
  
  const daysSinceRelease = (now.getTime() - releaseDate.getTime()) / (1000 * 60 * 60 * 24);

  // If release date is in the future, definitely not released
  if (daysSinceRelease < 0) {
    return false;
  }

  // If movie is older than 1 year, assume it has a digital release
  const ONE_YEAR_IN_DAYS = 365;
  if (daysSinceRelease >= ONE_YEAR_IN_DAYS) {
    return true;
  }

  // For recent movies (< 1 year old), check for explicit digital/physical/TV release
  // If no release data is available, show the movie (avoid false positives)
  if (!releaseAvailability?.hasReleaseDateData) {
    logger.debug(`Movie ${meta.name} has no release date data, showing by default`);
    return true;
  }

  // Type 4 = Digital, Type 5 = Physical, Type 6 = TV
  const hasDigitalRelease = isOnOrBeforeNow(releaseAvailability.earliestHomeReleaseDate, now);

  if (hasDigitalRelease) {
    logger.debug(`Movie ${meta.name} has digital release`);
    return true;
  }

  // Movie is recent (< 1 year) and no digital release confirmed - hide it
  logger.debug(`Movie ${meta.name} released ${Math.floor(daysSinceRelease)} days ago, no digital release found`);
  return false;
}

function getKitsuLocalizedTitle(titles, language = '') {
  if (!titles) return 'Unknown';
  // logger.debug(`[getKitsuLocalizedTitle] language: ${language}`);

  // Normalize the locale (e.g., "fr-FR" -> "fr_fr", "en-US" -> "en_us")
  const normalized = language.toLowerCase().replace('-', '_');
  const baseLang = normalized.split('_')[0]; // e.g. "fr"

  // Priority lookup order — most specific to general
  const candidates = [
    normalized,             // e.g. "fr_fr" or "en_us"
    baseLang,               // e.g. "fr" or "en" (prefer base language over _jp variants)
    `${baseLang}_us`,       // e.g. "en_us"
    `${baseLang}_jp`,       // e.g. "en_jp"
    'en',
    'en_jp',                // common English-Japanese hybrid
  ];

  for (const key of candidates) {
    if (titles[key]) return titles[key];
  }

  // Fallback to canonical title or "Unknown"
  return titles.canonicalTitle || 'Unknown';
}

module.exports = {
  parseMedia,
  parseCast,
  parseDirector,
  parseWriter,
  parseSlug,
  parseTrailers,
  parseTrailerStream,
  parseImdbLink,
  parseShareLink,
  parseGenreLink,
  parseCreditsLink,
  buildLinks,
  parseCoutry,
  parseGenres,
  parseYear,
  parseRunTime,
  parseCreatedBy,
  parseConfig,
  parsePoster,
  getRpdbPoster,
  getTopPosterPoster,
  getTopPosterThumbnail,
  getRatingPosterUrl,
  getPosterRatingApiKey,
  buildPosterProxyUrl,
  isPosterRatingEnabled,
  getDefaultPosterPattern,
  getDefaultThumbnailPattern,
  parsePosterWithProvider,
  checkIfExists,
  sortSearchResults,
  sortTvdbSearchResults,
  parseAnimeCreditsLink,
  getAnimeBg,
  parseAnimeCatalogMeta,
  parseAnimeCatalogMetaBatch,
  parseTvdbTrailers,
  parseAnimeRelationsLink,
  parseAnimeGenreLink,
  getAnimePoster,
  getAnimeLogo,
  getBatchAnimeArtwork,
  getMoviePoster,
  getMovieBackground,
  getMovieLogo,
  getTmdbMovieArtBatch,
  getSeriesPoster,
  getSeriesBackground,
  getSeriesLogo,
  getTmdbSeriesArtBatch,
  selectTmdbImageByLang,
  processBackgroundImage,
  convertAnilistBannerToBackground,
  getTmdbMovieCertificationForCountry,
  getTmdbTvCertificationForCountry,
  resolveArtProvider,
  addMetaProviderAttribution,
  processOverviewTranslations,
  processTitleTranslations,
  genSeasonsString,
  isReleasedDigitally,
  getTvdbCertification,
  getAnimePosterUrl,
  getKitsuLocalizedTitle,
  resolveCustomArtUrl
};

/**
 * Gets anime poster URL from various art providers
 */
async function getAnimePosterUrl(malId, mapping, stremioType, config, language, anilistArtworkMap, posterUrl, kitsuArtworkMap = null) {
  const artProvider = resolveArtProvider('anime', 'poster', config);
  const useAniList = artProvider === 'anilist';
  const useKitsu = artProvider === 'kitsu';
  const useTvdb = artProvider === 'tvdb';
  const useImdb = artProvider === 'imdb';
  const useTmdb = artProvider === 'tmdb';
  const useFanart = (artProvider === 'fanart' && !!config.apiKeys?.fanart);
  let finalPosterUrl = posterUrl || `${host}/missing_poster.png`;
  let tmdbId = stremioType === 'movie' ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals.tmdb : mapping?.themoviedb_id;
  let imdbId = stremioType === 'movie' ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals.imdb : mapping?.imdb_id;
  let tvdbId = stremioType === 'movie' ? (wikiMappings.getByImdbId(imdbId, stremioType))?.tvdbId || null : mapping?.tvdb_id;
  let poster;

  if (useAniList && anilistArtworkMap.has(malId)) {
    const anilistData = anilistArtworkMap.get(malId);
    const anilistPoster = anilist.getPosterUrl(anilistData);
    if (anilistPoster) {
      //console.log(`[parseAnimeCatalogMetaBatch] Using AniList poster for MAL ID: ${malId}`);
      finalPosterUrl = anilistPoster;
    } else {
      //console.log(`[parseAnimeCatalogMetaBatch] AniList data found but no poster URL for MAL ID: ${malId}`);
    }
  } else if (useAniList) {
    //console.log(`[parseAnimeCatalogMetaBatch] No AniList data found for MAL ID: ${malId}`);
  }
  
  // Check for Kitsu poster if configured as art provider
  if (useKitsu && mapping && mapping.kitsu_id) {
    // First try to use batch-fetched Kitsu artwork if available
    if (kitsuArtworkMap && kitsuArtworkMap.has(malId)) {
      const kitsuData = kitsuArtworkMap.get(malId);
      if (kitsuData?.attributes?.posterImage?.original) {
        //console.log(`[parseAnimeCatalogMetaBatch] Using batch-fetched Kitsu poster for MAL ID: ${malId}`);
        finalPosterUrl = kitsuData.attributes.posterImage.original;
      }
    } else {
      // Fallback to individual API call
      try {
        const kitsuData = await kitsu.getAnimeDetails(mapping.kitsu_id);
        if (kitsuData?.attributes?.posterImage?.original) {
          //console.log(`[parseAnimeCatalogMetaBatch] Using Kitsu poster for MAL ID: ${malId} (Kitsu ID: ${mapping.kitsu_id})`);
          finalPosterUrl = kitsuData.attributes.posterImage.original;
        }
      } catch (error) {
        logger.warn(`[parseAnimeCatalogMetaBatch] Kitsu poster fetch failed for MAL ID ${malId}:`, error.message);
      }
    }
  }
  
  // Check for TVDB poster if configured as art provider
  if (useTvdb && tvdbId) {
    try {
      // Use the appropriate TVDB function based on media type
      const tvdbPoster = stremioType === 'movie'
        ? await tvdb.getMoviePoster(tvdbId, config)
        : await tvdb.getSeriesPoster(tvdbId, config);
      
      if (tvdbPoster) {
        //console.log(`[parseAnimeCatalogMetaBatch] Using TVDB poster for MAL ID: ${malId} (TVDB ID: ${mapping.tvdb_id}, Type: ${stremioType})`);
        finalPosterUrl = tvdbPoster;
      }
    } catch (error) {
      logger.warn(`[parseAnimeCatalogMetaBatch] TVDB poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  // Check for TMDB poster if configured as art provider
  if (useTmdb && tmdbId) {
    try {
      // Use TMDB poster for anime
      const tmdbPoster = stremioType === 'movie' 
        ? await tmdb.getTmdbMoviePoster(tmdbId, config)
        : await tmdb.getTmdbSeriesPoster(tmdbId, config);
      
      if (tmdbPoster) {
        //console.log(`[parseAnimeCatalogMetaBatch] Using TMDB poster for MAL ID: ${malId} (TMDB ID: ${mapping.themoviedb_id}, Type: ${stremioType})`);
        finalPosterUrl = tmdbPoster;
      }
    } catch (error) {
      logger.warn(`[parseAnimeCatalogMetaBatch] TMDB poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }

  if (useImdb && imdbId) {
    try {
      finalPosterUrl = imdb.getPosterFromImdb(imdbId);
    } catch (error) {
      logger.warn(`[parseAnimeCatalogMetaBatch] IMDB poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  //console.log(`[parseAnimeCatalogMetaBatch] useFanart: ${useFanart} mapping: ${JSON.stringify(mapping)}`);
  if (useFanart) {
    try {
      if(tmdbId && stremioType === 'movie') {
        poster = await fanart.getBestMoviePoster(tmdbId, config);
        if (poster) {
          finalPosterUrl = poster;
        }
      } else if (imdbId && stremioType === 'movie') {
        poster = await fanart.getBestMoviePoster(imdbId, config);
        if (poster) {
          finalPosterUrl = poster;
        }
      } else if (tvdbId && stremioType === 'series') {
        poster = await fanart.getBestSeriesPoster(tvdbId, config);
        if (poster) {
          finalPosterUrl = poster;
        }
      }
    } catch (error) {
      logger.warn(`[parseAnimeCatalogMetaBatch] Fanart poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  // Check if poster rating is enabled (RPDB or Top Poster API)
  if (isPosterRatingEnabled(config)) {
    const proxyId = (imdbId ? `${imdbId}` : (tmdbId ? `tmdb:${tmdbId}` : tvdbId ? `tvdb:${tvdbId}` : null));

    if (proxyId) {
      finalPosterUrl = buildPosterProxyUrl(host, stremioType, proxyId, finalPosterUrl, language, config);
    }
  }

  return finalPosterUrl;
}
