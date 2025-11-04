const { decompressFromEncodedURIComponent } = require('lz-string');
const axios = require('axios');
const fanart = require('./fanart');
const anilist = require('../lib/anilist');
const tvdb = require('../lib/tvdb');
const tmdb = require('../lib/getTmdb');
const imdb = require('../lib/imdb');
const kitsu = require('../lib/kitsu');
const { resolveAllIds } = require('../lib/id-resolver');
const idMapper = require('../lib/id-mapper');
const { selectFanartImageByLang } = require('./fanart');
const { getImdbRating } = require('../lib/getImdbRating');
const consola = require('consola');
const { cacheWrapMetaSmart, cacheWrapGlobal } = require('../lib/getCache');
const wikiMappings = require('../lib/wiki-mapper.js');
const CATALOG_TTL = parseInt(process.env.CATALOG_TTL || 1 * 24 * 60 * 60, 10);
// Dynamic import to avoid circular dependency

const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

const logger = consola.create({ 
  level: process.env.LOG_LEVEL ? 
    (consola.LogLevels[process.env.LOG_LEVEL.toLowerCase()] ?? 4) : 
    (process.env.NODE_ENV === 'production' ? 3 : 4),
  fancy: true,
  colors: true,
  formatOptions: {
    colors: true,
    compact: false,
    date: false
  },
  tag: 'ParseProps'
});  

const isDebugEnabled = consola.level >= 4;

/**
 * Helper function to check if RPDB is enabled for the current context
 * Checks per-catalog settings if available, otherwise defaults to true
 */
function isRPDBEnabled(config) {
  // Check catalog-level RPDB setting (for catalog routes)
  if (config._currentCatalogConfig) {
    return config._currentCatalogConfig.enableRPDB !== false;
  }
  
  // Check search engine-level RPDB setting (for search routes)
  if (config._currentSearchEngine) {
    // Default to true if not explicitly set to false
    return config.search?.engineRPDB?.[config._currentSearchEngine] !== false;
  }
  
  // Default to true if neither catalog nor search context is set
  return true;
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
    LQ_EXACT: { MIN_VOTES: 5, MIN_POPULARITY: 0.5, RECENT_YEAR_SPAN: 5 },
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
    
    if (isMissingCoreData || isObscureContent) return false;

    // Stage 3: Case-by-Case Rules
    switch (item.matchReason) {
      case "Exact":
        const isRecent = item.year >= RULES.CURRENT_YEAR - RULES.LQ_EXACT.RECENT_YEAR_SPAN;
        const hasBasicEngagement = item.voteCount >= RULES.LQ_EXACT.MIN_VOTES || item.score >= RULES.LQ_EXACT.MIN_POPULARITY;
        const hasAnyRecentEngagement = isRecent && (item.voteCount > 0 || item.score > 0);
        return hasBasicEngagement || hasAnyRecentEngagement;

      case "StartsWith":
        const isCurrentYear = item.year === RULES.CURRENT_YEAR;
        if (isCurrentYear) {
          return item.voteCount >= RULES.STARTS_WITH.CURRENT_YEAR_MIN_VOTES || item.score >= RULES.STARTS_WITH.CURRENT_YEAR_MIN_POPULARITY;
        }
        return item.voteCount >= RULES.STARTS_WITH.MIN_VOTES || item.score >= RULES.STARTS_WITH.MIN_POPULARITY;

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
    name = processTitleTranslations(el.translations, config.language, name, type);
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

function processTitleTranslations(translations, language, title, type) {
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
        translation = tmdb.getTranslations(translations, 'en-US');
        if(translation && (translation.data.title || translation.data.name) && (translation.data.title || translation.data.name).trim() !== ''){
          title = type === 'movie' ? translation.data.title : translation.data.name;
        }
      }
    }
  } else {
    let translation = tmdb.getTranslations(translations, language);
    if(translation && (translation.data.title || translation.data.name) && (translation.data.title || translation.data.name).trim() !== ''){
      title = type === 'movie' ? translation.data.title : translation.data.name;
    } else {
      translation = tmdb.getTranslations(translations, 'en-US');
      if(translation && (translation.data.title || translation.data.name) && (translation.data.title || translation.data.name).trim() !== ''){
        title = type === 'movie' ? translation.data.title : translation.data.name;
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

  const voiceActorLinks = characterData.slice(0, castCount).map(charEntry => {
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
  const url = `${JIKAN_API_BASE}/genres/anime`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      console.error(`Could not fetch anime genres from Jikan`, e.message);
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
      console.log(`[Config Debug] Art providers:`, config.artProviders);
    }
    
    return config;
  } catch (e) {
    try { 
      const config = JSON.parse(catalogChoices);
      
      // Debug: Log art provider configuration
      if (config.artProviders) {
        console.log(`[Config Debug] Art providers:`, config.artProviders);
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
            fullMediaId = tvdbId;
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
            fullMediaId = tvdbId;
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

async function checkIfExists(url) {
  try {
    const response = await axios.head(url, {
      maxRedirects: 0,
      validateStatus: () => true,
      headers: { 'User-Agent': 'AIOMetadataAddon/1.0' }
    });
    return response.status === 200;
  } catch (error) {
    if (error.message.includes('Invalid URL')) {
      return false;
    }
    console.error(`Network error in checkIfExists for URL ${url}:`, error.message);
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

async function getAnimeBg({ tvdbId, tmdbId, malId, imdbId, malPosterUrl, mediaType = 'series' }, config) {
  
  console.log(`[getAnimeBg] Fetching background for ${mediaType} with TVDB ID: ${tvdbId}, TMDB ID: ${tmdbId}, MAL ID: ${malId}`);
  const artProvider = resolveArtProvider('anime', 'background', config);
  const mapping = malId ? idMapper.getMappingByMalId(malId) : null;
  tvdbId = tvdbId 
  tmdbId = tmdbId 
  imdbId = imdbId 
  // Check art provider preference
  
  
  if (artProvider === 'anilist' && malId) {
    try {
      const anilistData = await anilist.getAnimeArtwork(malId);
      console.log(`[getAnimeBg] AniList data for MAL ID ${malId}:`, {
        hasData: !!anilistData,
        hasBannerImage: !!anilistData?.bannerImage,
        bannerImage: anilistData?.bannerImage?.substring(0, 50) + '...'
      });
      
      if (anilistData) {
        const anilistBackground = anilist.getBackgroundUrl(anilistData);
        console.log(`[getAnimeBg] AniList background URL for MAL ID ${malId}:`, anilistBackground?.substring(0, 50) + '...');
        
        if (anilistBackground) {
          console.log(`[getAnimeBg] Found AniList background for MAL ID: ${malId}`);
          return anilistBackground;
        } else {
          console.log(`[getAnimeBg] No AniList background URL found for MAL ID: ${malId}`);
        }
      }
    } catch (error) {
      console.warn(`[getAnimeBg] AniList background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (artProvider === 'kitsu' && mapping?.kitsu_id && config.providers?.anime !== 'kitsu') {
    try {
      const kitsuData = await kitsu.getMultipleAnimeDetails([mapping.kitsu_id]);
      console.log(`[getAnimeBg] Kitsu data for MAL ID ${malId}:`, {
        hasData: !!kitsuData,
        hasCoverImage: !!kitsuData?.data?.[0]?.attributes?.coverImage,
        coverImage: kitsuData?.data?.[0]?.attributes?.coverImage?.original?.substring(0, 50) + '...'
      });
      
      if (kitsuData?.data?.[0]?.attributes?.coverImage?.original) {
        console.log(`[getAnimeBg] Found Kitsu background for MAL ID: ${malId} (Kitsu ID: ${mapping.kitsu_id})`);
        return kitsuData.data[0].attributes.coverImage.original;
      } else {
        console.log(`[getAnimeBg] No Kitsu background URL found for MAL ID: ${malId}`);
      }
    } catch (error) {
      console.warn(`[getAnimeBg] Kitsu background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (artProvider === 'tvdb' && tvdbId) {
    try {
      // Use the appropriate TVDB function based on media type
      const tvdbBackground = mediaType === 'movie'
          ? await tvdb.getMovieBackground(tvdbId, config)
          : await tvdb.getSeriesBackground(tvdbId, config);
        
        if (tvdbBackground) {
          console.log(`[getAnimeBg] Found TVDB background for MAL ID: ${malId} (TVDB ID: ${mapping.thetvdb_id}, Type: ${mediaType})`);
          return tvdbBackground;
        }
    } catch (error) {
      console.warn(`[getAnimeBg] TVDB background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }

  if (artProvider === 'imdb' && imdbId) {
    try {
      return imdb.getBackgroundFromImdb(imdbId);
    } catch (error) {
      console.warn(`[getAnimeBg] IMDB background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }

  if (artProvider === 'tmdb' && tmdbId) {
    try {
      // Use TMDB background for anime
        const tmdbBackground = mediaType === 'movie' 
          ? await tmdb.movieImages({ id: tmdbId, include_image_language: null }, config).then(res => {
            const img = res.backdrops[0];
            return `https://image.tmdb.org/t/p/original${img?.file_path}`;
          })
          : await tmdb.tvImages({ id: tmdbId, include_image_language: null }, config).then(res => {
            const img = res.backdrops[0];
            return `https://image.tmdb.org/t/p/original${img?.file_path}`;
          });
        
        if (tmdbBackground) {
          console.log(`[getAnimeBg] Found TMDB background for MAL ID: ${malId} (TMDB ID: ${tmdbId}, Type: ${mediaType})`);
          return tmdbBackground;
        }
    } catch (error) {
      console.warn(`[getAnimeBg] TMDB background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (config.apiKeys.fanart && artProvider === 'fanart') {
    console.log(`[getAnimeBg] Fetching background from Fanart.tv for ${mediaType}`);
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
      console.log(`[getAnimeBg] Found high-quality Fanart.tv background.`);
      return fanartUrl;
    }
  }

  console.log(`[getAnimeBg] No Fanart or TMDB background found. Falling back to MAL poster.`);
  return malPosterUrl;
}


/**
 * Get anime logo with art provider preference
 */
async function getAnimeLogo({ malId, imdbId, tvdbId, tmdbId, mediaType = 'series' }, config) {
  const artProvider = resolveArtProvider('anime', 'logo', config);
  const mapping = malId ? idMapper.getMappingByMalId(malId) : null;
  tvdbId = tvdbId || mapping?.thetvdb_id;
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
      console.warn(`[getAnimeLogo] TVDB logo fetch failed for MAL ID ${malId}:`, error.message);
    }
  }

  if (artProvider === 'imdb' && imdbId) {
    try {
      return imdb.getLogoFromImdb(imdbId);
    } catch (error) {
      console.warn(`[getAnimeLogo] IMDB logo fetch failed for MAL ID ${malId}:`, error.message);
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
      console.warn(`[getAnimeLogo] TMDB logo fetch failed for MAL ID ${malId}:`, error.message);
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
      console.log(`[getAnimeLogo] Found high-quality back up logo from Fanart.tv.`);
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
  tvdbId = tvdbId || mapping?.thetvdb_id;
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
      console.warn(`[getAnimePoster] AniList poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (artProvider === 'kitsu' && malId && mapping?.kitsu_id && config.providers?.anime !== 'kitsu') {
    try {
      const kitsuData = await kitsu.getMultipleAnimeDetails([mapping.kitsu_id]);
      if (kitsuData?.data?.[0]?.attributes?.posterImage?.original) {
        console.log(`[getAnimePoster] Found Kitsu poster for MAL ID: ${malId} (Kitsu ID: ${mapping.kitsu_id})`);
        return kitsuData.data[0].attributes.posterImage.original;
      }
    } catch (error) {
      console.warn(`[getAnimePoster] Kitsu poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (artProvider === 'tvdb' && tvdbId) {
    try {
      const tvdbPoster = mediaType === 'movie' 
          ? await tvdb.getMoviePoster(tvdbId, config)
          : await tvdb.getSeriesPoster(tvdbId, config);

      if (tvdbPoster) {
        //console.log(`[getAnimePoster] Found TVDB poster for MAL ID: ${malId} (TVDB ID: ${tvdbId}, Type: ${mediaType})`);
        return tvdbPoster;
      }
    } catch (error) {
      console.warn(`[getAnimePoster] TVDB poster fetch failed for ID ${malId || imdbId}:`, error.message);
    }
  }

  if (artProvider === 'imdb' && imdbId) {
    try {
      return imdb.getPosterFromImdb(imdbId);
    } catch (error) {
      console.warn(`[getAnimePoster] IMDB poster fetch failed for ID ${malId || imdbId}:`, error.message);
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
      console.warn(`[getAnimePoster] TMDB poster fetch failed for ID ${malId || imdbId}:`, error.message);
    }
  }
  if (config.apiKeys.fanart && artProvider === 'fanart') {
    let fanartUrl = null;
    console.log(`[getAnimePoster] Fetching background for ${mediaType} with TVDB ID: ${tvdbId}, TMDB ID: ${tmdbId}`);
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
      console.log(`[getBatchAnimeArtwork] Retrieved ${artworkData.length} AniList artworks for ${malIds.length} MAL IDs`);
      return artworkData;
    } catch (error) {
      console.warn(`[getBatchAnimeArtwork] AniList batch fetch failed:`, error.message);
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
        console.log(`[getBatchAnimeArtwork] Retrieved ${kitsuData?.data?.length || 0} Kitsu artworks for ${kitsuIds.length} Kitsu IDs`);
        return kitsuData?.data || [];
      }
    } catch (error) {
      console.warn(`[getBatchAnimeArtwork] Kitsu batch fetch failed:`, error.message);
    }
  }
  
  return [];
}

async function parseAnimeCatalogMeta(anime, config, language, descriptionFallback = null) {
  if (!anime || !anime.mal_id) return null;

  const malId = anime.mal_id;
  const stremioType = anime.type?.toLowerCase() === 'movie' ? 'movie' : 'series';
  const preferredProvider = config.providers?.anime || 'mal';

  const mapping = idMapper.getMappingByMalId(malId);
  let id = `mal:${malId}`;
  if (preferredProvider === 'tvdb') {
    if (mapping && mapping.thetvdb_id) {
      id= `tvdb:${mapping.thetvdb_id}`;
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
          console.log(`[parseAnimeCatalogMeta] Using AniList poster for MAL ID: ${malId}`);
          finalPosterUrl = anilistPoster;
        }
      }
    } catch (error) {
      console.warn(`[parseAnimeCatalogMeta] AniList poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  } else if (artProvider === 'tvdb' && malId) {
    try {
      const mapping = idMapper.getMappingByMalId(malId);
      if (mapping && mapping.thetvdb_id) {
        // Use the appropriate TVDB function based on media type
        const tvdbPoster = stremioType === 'movie'
          ? await tvdb.getMoviePoster(mapping.thetvdb_id, config)
          : await tvdb.getSeriesPoster(mapping.thetvdb_id, config);
        
        if (tvdbPoster) {
          console.log(`[parseAnimeCatalogMeta] Using TVDB poster for MAL ID: ${malId} (TVDB ID: ${mapping.thetvdb_id}, Type: ${stremioType})`);
          finalPosterUrl = tvdbPoster;
        }
      }
    } catch (error) {
      console.warn(`[parseAnimeCatalogMeta] TVDB poster fetch failed for MAL ID ${malId}:`, error.message);
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
          console.log(`[parseAnimeCatalogMeta] Using TMDB poster for MAL ID: ${malId} (TMDB ID: ${mapping.themoviedb_id}, Type: ${stremioType})`);
          finalPosterUrl = tmdbPoster;
        }
      }
    } catch (error) {
      console.warn(`[parseAnimeCatalogMeta] TMDB poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  //const kitsuId = mapping?.kitsu_id;
  const imdbId = mapping?.imdb_id;
  const tmdbId = mapping?.themoviedb_id;
  const kitsuId = mapping?.kitsu_id;
  const imdbRating = await getImdbRating(imdbId, stremioType);
  //const metaType = (kitsuId || imdbId) ? stremioType : 'anime';
  // Check if RPDB is enabled (check catalog-specific setting if available, otherwise default to true)
  if (config.apiKeys?.rpdb && isRPDBEnabled(config)) {

    if (mapping) {
      const tvdbId = mapping.thetvdb_id;
      const tmdbId = mapping.themoviedb_id;
      let proxyId = null;

      if (stremioType === 'series') {
        proxyId = tvdbId ? `tvdb:${tvdbId}` : (tmdbId ? `tmdb:${tmdbId}` : null);
      } else if (stremioType === 'movie') {
        proxyId = tmdbId ? `tmdb:${tmdbId}` : null;
      }

      if (proxyId) {
        const fallback = encodeURIComponent(finalPosterUrl);
        finalPosterUrl = `${host}/poster/${stremioType}/${proxyId}?fallback=${fallback}&lang=${language}&key=${config.apiKeys?.rpdb}`;
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
async function parseAnimeCatalogMetaBatch(animes, config, language) {
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
  let anilistArtworkMap = new Map();
  const kitsuMalMap = new Map();
  
  if (useAniList && malIds.length > 0) {
    try {
      //console.log(`[parseAnimeCatalogMetaBatch] Fetching AniList artwork for ${malIds.length} anime in batch`);
      //console.log(`[parseAnimeCatalogMetaBatch] MAL IDs: ${malIds.slice(0, 10).join(', ')}${malIds.length > 10 ? '...' : ''}`);
      
      // First, try to get AniList IDs from mappings
      const malToAnilistMap = new Map();
      const anilistIds = [];
      const kitsuIds = [];
      const malIdsWithoutAnilist = [];
      const malIdsWithoutKitsu = [];
      
      malIds.forEach(malId => {
        const mapping = idMapper.getMappingByMalId(malId);
        if (mapping && mapping.anilist_id) {
          malToAnilistMap.set(mapping.anilist_id, malId);
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
      console.warn(`[parseAnimeCatalogMetaBatch] AniList batch fetch failed:`, error.message);
    }
  }
  
  // Fetch Kitsu artwork if configured as art provider
  let kitsuArtworkMap = new Map();
  if (useKitsu && malIds.length > 0) {
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
        if (kitsuData?.data) {
          // Create a map for quick lookup using MAL ID as key
          kitsuArtworkMap = new Map();
          kitsuData.data.forEach(item => {
            const mapping = idMapper.getMappingByKitsuId(item.id);
            if (mapping?.mal_id) {
              kitsuArtworkMap.set(mapping.mal_id, item);
            }
          });
          console.log(`[parseAnimeCatalogMetaBatch] Successfully fetched ${kitsuData.data.length} Kitsu artworks`);
        }
      }
    } catch (error) {
      console.warn(`[parseAnimeCatalogMetaBatch] Kitsu batch fetch failed:`, error.message);
    }
  }
  
  const preferredProvider = config.providers?.anime || 'mal';
  consola.log(`[parseAnimeCatalogMetaBatch] Preferred provider: ${preferredProvider}`);

  if(preferredProvider === 'kitsu') {
    try {
      let metas = await Promise.all(malIds.map(async id => {
        consola.log(`[parseAnimeCatalogMetaBatch] Fetching Kitsu data for ID: ${id}`);
        
        const mapping = idMapper.getMappingByMalId(id);
        if(!mapping || !mapping.kitsu_id) return parseAnimeCatalogMeta(animes.find(anime => anime.mal_id === id), config, language);
        const kitsuData = await cacheWrapGlobal(
          `kitsu-anime-${mapping.kitsu_id}-genres`,
          () => kitsu.getMultipleAnimeDetails([mapping.kitsu_id]),
          CATALOG_TTL
        );
        const item = kitsuData.data[0];
        const stremioType = item.attributes.subtype === 'movie' ? 'movie' : 'series';
        let tmdbId = stremioType === 'movie' ? idMapper.getTraktAnimeMovieByMalId(id)?.externals.tmdb : mapping?.themoviedb_id;
        let imdbId = stremioType === 'movie' ? idMapper.getTraktAnimeMovieByMalId(id)?.externals.imdb : mapping?.imdb_id;
        let tvdbId = stremioType === 'movie' ? (await wikiMappings.getByImdbId(imdbId, stremioType))?.tvdbId || null : mapping?.thetvdb_id;
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
        let genres = item.included?.filter(item => item.type === 'genres').map(item => item.attributes?.name) || [];
        return {
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
      }));
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
      console.warn(`[parseAnimeCatalogMetaBatch] Kitsu batch fetch failed:`, error.message);
    }
  }
  // Process each anime
  const results = await Promise.all(animes.map(async anime => {
    if (!anime || !anime.mal_id) return null;

    const malId = anime.mal_id;
    const stremioType = anime.type?.toLowerCase() === 'movie' ? 'movie' : 'series';
    

    const mapping = idMapper.getMappingByMalId(malId);
    let tmdbId = stremioType === 'movie' ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals.tmdb : mapping?.themoviedb_id;
    let imdbId = stremioType === 'movie' ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals.imdb : mapping?.imdb_id;
    let tvdbId = stremioType === 'movie' ? (await wikiMappings.getByImdbId(imdbId, stremioType))?.tvdbId || null : mapping?.thetvdb_id;
    
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
    let finalPosterUrl = malPosterUrl || `${host}/missing_poster.png`;
    
    // Use batch-fetched AniList artwork if available
    finalPosterUrl = await getAnimePosterUrl(malId, mapping, stremioType, config, language, anilistArtworkMap, anime.images?.jpg?.large_image_url, kitsuArtworkMap);
    const imdbRating = await getImdbRating(imdbId, stremioType);
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
    if((config.mal?.useImdbIdForCatalogAndSearch && stremioType === 'series')){
      return (await cacheWrapMetaSmart(config.userUUID, id, async () => {
        const { getMeta } = await import("../lib/getMeta");
        return await getMeta(stremioType, language, `mal:${malId}`, config, config.userUUID, false);
      }, undefined, {enableErrorCaching: true, maxRetries: 2}, stremioType, false))?.meta || null;
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
      return {
        id: `mal:${malId}`,
        type: stremioType,
        logo: stremioType === 'movie' ? await tmdb.getTmdbMovieLogo(tmdbId, config) : await tmdb.getTmdbSeriesLogo(tmdbId, config),
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
    console.warn(`[Parser] Could not parse invalid URL for YouTube ID: ${url}`);
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

/**
 * Get movie poster with art provider preference
 */
async function getMoviePoster({ tmdbId, tvdbId, imdbId, metaProvider, fallbackPosterUrl }, config) {
  const artProvider = resolveArtProvider('movie', 'poster', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
      const tvdbPoster = await tvdb.getMoviePoster(tvdbId, config);
      if (tvdbPoster) {
        console.log(`[getMoviePoster] Found TVDB poster for movie (TVDB ID: ${tvdbId})`);
          return tvdbPoster;
        }
      }
      else {
        if(!tmdbId) return fallbackPosterUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'movie', config);
        if(mappedIds.tvdbId) {
          const tvdbPoster = await tvdb.getMoviePoster(mappedIds.tvdbId, config);
          console.log(`[getMoviePoster] Found TVDB poster via ID mapping for movie (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbPoster;
        }
      }
    } catch (error) {
      console.warn(`[getMoviePoster] TVDB poster fetch failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const poster = await fanart.getBestMoviePoster(tmdbId, config);
        if (poster) {
          console.log(`[getMoviePoster] Found Fanart.tv poster for movie (TMDB ID: ${tmdbId})`);
          return poster;
        }
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const poster = await fanart.getBestMoviePoster(mappedIds.tmdbId, config);
          if (poster) {
            console.log(`[getMoviePoster] Found Fanart.tv poster via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return poster;
          }
        }
      }
    } catch (error) {
      console.warn(`[getMoviePoster] Fanart.tv poster fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const tmdbPoster = await tmdb.movieImages({ id: tmdbId }, config).then(res => {
          const img = selectTmdbImageByLang(res.posters, config);
          return img?.file_path;
        });
        console.log(`[getMoviePoster] Found TMDB poster for movie (TMDB ID: ${tmdbId})`);
        return `https://image.tmdb.org/t/p/w600_and_h900_bestv2${tmdbPoster}`;
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const tmdbPoster = await tmdb.movieImages({ id: mappedIds.tmdbId }, config).then(res => {
            const img = selectTmdbImageByLang(res.posters, config);
            return img?.file_path;
          });
          console.log(`[getMoviePoster] Found TMDB poster via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
          return `https://image.tmdb.org/t/p/w500${tmdbPoster}`;
        }
      }
    } catch (error) {
      console.warn(`[getMoviePoster] TMDB ID mapping failed for movie (TVDB ID: ${tvdbId}):`, error.message);
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
async function getMovieBackground({ tmdbId, tvdbId, imdbId, metaProvider, fallbackBackgroundUrl }, config) {
  const artProvider = resolveArtProvider('movie', 'background', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        console.log(`[getMovieBackground] Fetching TVDB background for movie (TVDB ID: ${tvdbId})`);
        const tvdbBackground = await tvdb.getMovieBackground(tvdbId, config);
        if (tvdbBackground) {
          console.log(`[getMovieBackground] Found TVDB background for movie (TVDB ID: ${tvdbId}): ${tvdbBackground.substring(0, 50)}...`);
          return tvdbBackground;
        }
      }
      else {
        if(!tmdbId) return fallbackBackgroundUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'movie', config);
        if(mappedIds.tvdbId) {
          const tvdbBackground = await tvdb.getMovieBackground(mappedIds.tvdbId, config);
          console.log(`[getMovieBackground] Found TVDB background via ID mapping for movie (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbBackground;
        }
      }
    } catch (error) {
      console.warn(`[getMovieBackground] TVDB background fetch failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const bg = await fanart.getBestMovieBackground(tmdbId, config);
        if (bg) {
          console.log(`[getMovieBackground] Found Fanart.tv background for movie (TMDB ID: ${tmdbId})`);
          return bg;
        }
      }
      else {
        if(!tvdbId) return fallbackBackgroundUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const bg = await fanart.getBestMovieBackground(mappedIds.tmdbId, config);
          if (bg) {
            console.log(`[getMovieBackground] Found Fanart.tv background via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return bg;
          }
        }
      }
    } catch (error) {
      console.warn(`[getMovieBackground] Fanart.tv background fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const tmdbBackground = await tmdb.movieImages({ id: tmdbId, include_image_language: null }, config).then(res => {
          const img = res.backdrops[0];
          return img?.file_path;
        });
        console.log(`[getMovieBackground] Found TMDB background for movie (TMDB ID: ${tmdbId})`);
        return `https://image.tmdb.org/t/p/original${tmdbBackground}`;
      }
      else {
        if(!tvdbId) return fallbackBackgroundUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const tmdbBackground = await tmdb.movieImages({ id: mappedIds.tmdbId, include_image_language: null }, config).then(res => {
            const img = res.backdrops[0];
            return img?.file_path;
          });
          console.log(`[getMovieBackground] Found TMDB background via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
          return `https://image.tmdb.org/t/p/original${tmdbBackground}`;
        }
      }
    } catch (error) {
      console.warn(`[getMovieBackground] TMDB ID mapping failed for movie (TVDB ID: ${tvdbId}):`, error.message);
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
async function getMovieLogo({ tmdbId, tvdbId, imdbId, metaProvider, fallbackLogoUrl }, config) {
  const artProvider = resolveArtProvider('movie', 'logo', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        const tvdbLogo = await tvdb.getMovieLogo(tvdbId, config);
        if (tvdbLogo) {
          console.log(`[getMovieLogo] Found TVDB logo for movie (TVDB ID: ${tvdbId})`);
          return tvdbLogo;
        }
      }
      else {
        if(!tmdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'movie', config);
        if(mappedIds.tvdbId) {
          const tvdbLogo = await tvdb.getMovieLogo(mappedIds.tvdbId, config);
          console.log(`[getMovieLogo] Found TVDB logo via ID mapping for movie (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbLogo;
        }
      }
    } catch (error) {
      console.warn(`[getMovieLogo] TVDB logo fetch failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const logo = await fanart.getBestMovieLogo(tmdbId, config);
        if (logo) {
          console.log(`[getMovieLogo] Found Fanart.tv logo for movie (TMDB ID: ${tmdbId})`);
          return logo;
        }
      }
      else {
        if(!tvdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const logo = await fanart.getBestMovieLogo(mappedIds.tmdbId, config);
          if (logo) {
            console.log(`[getMovieLogo] Found Fanart.tv logo via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return logo;
          }
        }
      }
    } catch (error) {
      console.warn(`[getMovieLogo] Fanart.tv logo fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const tmdbLogo = await tmdb.movieImages({ id: tmdbId }, config).then(res => {
          const img = selectTmdbImageByLang(res.logos, config);
          return img?.file_path;
        });
        if (tmdbLogo) {
          console.log(`[getMovieLogo] Found TMDB logo for movie (TMDB ID: ${tmdbId})`);
          return `https://image.tmdb.org/t/p/original${tmdbLogo}`;
        }
      }
      else {
        if(!tvdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const tmdbLogo = await tmdb.movieImages({ id: mappedIds.tmdbId }, config).then(res => {
            const img = selectTmdbImageByLang(res.logos, config);
            return img?.file_path;
          });
          if (tmdbLogo) {
            console.log(`[getMovieLogo] Found TMDB logo via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return `https://image.tmdb.org/t/p/original${tmdbLogo}`;
          }
        }
      }
    } catch (error) {
      console.warn(`[getMovieLogo] TMDB logo fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
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

/**
 * Get series poster with art provider preference
 */
async function getSeriesPoster({ tmdbId, tvdbId, imdbId, metaProvider, fallbackPosterUrl }, config) {
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
      console.warn(`[getSeriesPoster] TVDB poster fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
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
      console.warn(`[getSeriesPoster] Fanart.tv poster fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const tmdbPoster = await tmdb.tvImages({ id: tmdbId }, config).then(res => {
          const img = selectTmdbImageByLang(res.posters, config);
          return img?.file_path;
        });
        if (tmdbPoster) {
          return `https://image.tmdb.org/t/p/w600_and_h900_bestv2${tmdbPoster}`;
        }
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'series', config, null, ['tmdb']);
        if(mappedIds.tmdbId) {
          const tmdbPoster = await tmdb.tvImages({ id: mappedIds.tmdbId }, config).then(res => {
            const img = selectTmdbImageByLang(res.posters, config);
            return img?.file_path;
          });
          if (tmdbPoster) {
            return `https://image.tmdb.org/t/p/w600_and_h900_bestv2${tmdbPoster}`;
          }
        }
      }
    } catch (error) {
      console.warn(`[getSeriesPoster] TMDB ID mapping failed for series (TVDB ID: ${tvdbId}):`, error.message);
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
async function getSeriesBackground({ tmdbId, tvdbId, imdbId, metaProvider, fallbackBackgroundUrl }, config) {
  const artProvider = resolveArtProvider('series', 'background', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
      const tvdbBackground = await tvdb.getSeriesBackground(tvdbId, config);
      if (tvdbBackground) {
        console.log(`[getSeriesBackground] Found TVDB background for series (TVDB ID: ${tvdbId})`);
          return tvdbBackground;
        }
      }
      else {
        if(!tmdbId) return fallbackBackgroundUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config, null, ['tvdb']);
        if(mappedIds.tvdbId) {
          const tvdbBackground = await tvdb.getSeriesBackground(mappedIds.tvdbId, config);
          console.log(`[getSeriesBackground] Found TVDB background via ID mapping for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbBackground;
        }
      }
    } catch (error) {
      console.warn(`[getSeriesBackground] TVDB background fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tvdbId) {
        const bg = await fanart.getBestSeriesBackground(tvdbId, config);
        if (bg) {
          console.log(`[getSeriesBackground] Found Fanart.tv background for series (TVDB ID: ${tvdbId})`);
          return bg;
        }
      } else if(tmdbId) {
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config);
        if(mappedIds.tvdbId) {
          const bg = await fanart.getBestSeriesBackground(mappedIds.tvdbId, config);
          if (bg) {
            console.log(`[getSeriesBackground] Found Fanart.tv background via ID mapping for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
            return bg;
          }
        }
      }
          
    } catch (error) {
      console.warn(`[getSeriesBackground] Fanart.tv background fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const tmdbBackground = await tmdb.tvImages({ id: tmdbId, include_image_language: null }, config).then(res => {
          const img = res.backdrops[0];
          return img?.file_path;
        });
        console.log(`[getSeriesBackground] Found TMDB background for series (TMDB ID: ${tmdbId})`);
        return `https://image.tmdb.org/t/p/original${tmdbBackground}`;
      }
      else {
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'series', config, null, ['tmdb']);
        if(mappedIds.tmdbId) {
          const tmdbBackground = await tmdb.tvImages({ id: mappedIds.tmdbId, include_image_language: null }, config).then(res => {
            const img = res.backdrops[0];
            return img?.file_path;
          });
          console.log(`[getSeriesBackground] Found TMDB background via ID mapping for series (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
          return `https://image.tmdb.org/t/p/original${tmdbBackground}`;
        }
      }
    } catch (error) {
      console.warn(`[getSeriesBackground] TMDB ID mapping failed for series (TVDB ID: ${tvdbId}):`, error.message);
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
async function getSeriesLogo({ tmdbId, tvdbId, imdbId, metaProvider, fallbackLogoUrl }, config) {
  const artProvider = resolveArtProvider('series', 'logo', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        const tvdbLogo = await tvdb.getSeriesLogo(tvdbId, config);
        if (tvdbLogo) {
        console.log(`[getSeriesLogo] Found TVDB logo for series (TVDB ID: ${tvdbId})`);
          return tvdbLogo;
        }
      }
      else {
        if(!tmdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config, null, ['tvdb']);
        if(mappedIds.tvdbId) {
          const tvdbLogo = await tvdb.getSeriesLogo(mappedIds.tvdbId, config);
          console.log(`[getSeriesLogo] Found TVDB logo via ID mapping for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbLogo;
        }
      }
    } catch (error) {
      console.warn(`[getSeriesLogo] TVDB logo fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tvdbId) {
        const logo = await fanart.getBestTVLogo(tvdbId, config);
        if (logo) {
          console.log(`[getSeriesLogo] Found Fanart.tv logo for series (TVDB ID: ${tvdbId})`);
          return logo;
        }
      }
      else if(tmdbId) {
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config, null, ['tvdb']);
        if(mappedIds.tvdbId) {
          console.log(`[getSeriesLogo] Fetching Fanart.tv logo for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          const logo = await fanart.getBestTVLogo(mappedIds.tvdbId, config);
          if (logo) {
            console.log(`[getSeriesLogo] Found Fanart.tv logo for series (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tvdbId})`);
            return logo;
          }
        }
      }
      else {
        return fallbackLogoUrl;
      }
    } catch (error) {
      console.warn(`[getSeriesLogo] Fanart.tv logo fetch failed for series (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const langCode = config.language.split('-')[0];
        const imageLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
        const tmdbLogo = await tmdb.tvImages({ id: tmdbId, include_image_language: imageLanguages }, config).then(res => {
          const img = selectTmdbImageByLang(res.logos, config);
          return img?.file_path;
        });
        if (tmdbLogo) {
          console.log(`[getSeriesLogo] Found TMDB logo for series (TMDB ID: ${tmdbId})`);
          return `https://image.tmdb.org/t/p/original${tmdbLogo}`;
        }
      }
      else {
        if(!tvdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'series', config);
        if(mappedIds.tmdbId) {
          const langCode = config.language.split('-')[0];
          const imageLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
          const tmdbLogo = await tmdb.tvImages({ id: mappedIds.tmdbId, include_image_language: imageLanguages }, config).then(res => {
            const img = selectTmdbImageByLang(res.logos, config);
            return img?.file_path;
          });
          if (tmdbLogo) {
            console.log(`[getSeriesLogo] Found TMDB logo via ID mapping for series (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return `https://image.tmdb.org/t/p/original${tmdbLogo}`;
          }
        }
      }
    } catch (error) {
      console.warn(`[getSeriesLogo] TMDB logo fetch failed for series (TMDB ID: ${tmdbId}):`, error.message);
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
 * @param {boolean} options.addGradient - Whether to add gradient overlay (default: false)
 * @param {string} options.gradientType - Gradient type: 'dark' or 'light' (default: 'dark')
 * @param {number} options.gradientOpacity - Gradient opacity 0-1 (default: 0.6)
 * @returns {string} Processed background image URL
 */
function convertBannerToBackgroundUrl(bannerUrl, options = {}) {
  if (!bannerUrl) return null;
  
  const {
    width = 1920,
    height = 1080,
    blur = 0,
    brightness = 1,
    contrast = 1,
    addGradient = false,
    gradientType = 'dark',
    gradientOpacity = 0.6
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

  let endpoint = '/api/image/banner-to-background';
  
  // If gradient is requested, use the gradient overlay endpoint
  if (addGradient) {
    endpoint = '/api/image/gradient-overlay';
    params.delete('width', 'height', 'blur', 'brightness', 'contrast');
    params.set('gradient', gradientType);
    params.set('opacity', gradientOpacity.toString());
  }

  return `${host}${endpoint}?${params.toString()}`;
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
      addGradient: true, // Add dark gradient overlay
      gradientOpacity: 0.5,
      ...options
    });
  }

  // If it's a poster, convert to background with more processing
  if (imageType === 'poster') {
    return convertBannerToBackgroundUrl(imageUrl, {
      blur: 3, // More blur for posters
      brightness: 0.8, // Darker for better contrast
      addGradient: true,
      gradientOpacity: 0.6,
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
function selectTmdbImageByLang(images, config, key = 'iso_639_1') {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  
  // If englishArtOnly is enabled, force English language selection
  const targetLang = config.artProviders?.englishArtOnly ? 'en' : (config.language?.split('-')[0]?.toLowerCase() || 'en');
  const targetCountry = config.language.split('-')[1]?.toUpperCase() || 'US';
  
  // Sort by vote_average descending
  return (
    images.find(img => img[key] === targetLang && img.iso_3166_1 === targetCountry) ||
    images.find(img => img[key] === targetLang) ||
    images.find(img => img[key] === 'en') ||
    images[0]
  );
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

  // Check if movie has a release date
  if (!meta.released) {
    // No release date means it's unreleased or unknown - keep due to lack of data
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
  if (!meta.app_extras?.releaseDates?.results) {
    logger.debug(`Movie ${meta.name} has no release date data, showing by default`);
    return true;
  }

  // Type 4 = Digital, Type 5 = Physical, Type 6 = TV
  const hasDigitalRelease = meta.app_extras?.releaseDates?.results?.some((country) =>
    country.release_dates?.some((release) =>
      release.type >= 4 && release.type <= 6 && new Date(release.release_date) <= now
    )
  );

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
  console.log(`[getKitsuLocalizedTitle] language: ${language}`);

  // Normalize the locale (e.g., "fr-FR" -> "fr_fr", "en-US" -> "en_us")
  const normalized = language.toLowerCase().replace('-', '_');
  const baseLang = normalized.split('_')[0]; // e.g. "fr"

  // Priority lookup order — most specific to general
  const candidates = [
    normalized,             // e.g. "fr_fr"
    `${baseLang}_jp`,       // e.g. "en_jp"
    `${baseLang}_us`,       // e.g. "en_us"
    baseLang,               // e.g. "fr"
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
  getSeriesPoster,
  getSeriesBackground,
  getSeriesLogo,
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
  isRPDBEnabled
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
  let tvdbId = stremioType === 'movie' ? (await wikiMappings.getByImdbId(imdbId, stremioType))?.tvdbId || null : mapping?.thetvdb_id;

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
        console.warn(`[parseAnimeCatalogMetaBatch] Kitsu poster fetch failed for MAL ID ${malId}:`, error.message);
      }
    }
  }
  
  // Check for TVDB poster if configured as art provider
  if (useTvdb && tvdbId) {
    try {
      // Use the appropriate TVDB function based on media type
      const tvdbPoster = await tvdb.getSeriesPoster(tvdbId, config);
      
      if (tvdbPoster) {
        //console.log(`[parseAnimeCatalogMetaBatch] Using TVDB poster for MAL ID: ${malId} (TVDB ID: ${mapping.thetvdb_id}, Type: ${stremioType})`);
        finalPosterUrl = tvdbPoster;
      }
    } catch (error) {
      console.warn(`[parseAnimeCatalogMetaBatch] TVDB poster fetch failed for MAL ID ${malId}:`, error.message);
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
      console.warn(`[parseAnimeCatalogMetaBatch] TMDB poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }

  if (useImdb && imdbId) {
    try {
      finalPosterUrl = imdb.getPosterFromImdb(imdbId);
    } catch (error) {
      console.warn(`[parseAnimeCatalogMetaBatch] IMDB poster fetch failed for MAL ID ${malId}:`, error.message);
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
      console.warn(`[parseAnimeCatalogMetaBatch] Fanart poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  // Check if RPDB is enabled (check catalog-specific setting if available, otherwise default to true)
  if (config.apiKeys?.rpdb && isRPDBEnabled(config)) {
    let proxyId = null;
    proxyId = (imdbId ? `${imdbId}`: (tmdbId ? `tmdb:${tmdbId}` :  tvdbId ? `tvdb:${tvdbId}` : null));

      if (proxyId) {
        const fallback = encodeURIComponent(finalPosterUrl);
        finalPosterUrl = `${host}/poster/${stremioType}/${proxyId}?fallback=${fallback}&lang=${language}&key=${config.apiKeys?.rpdb}`;
      }
  }

  return finalPosterUrl;
}
