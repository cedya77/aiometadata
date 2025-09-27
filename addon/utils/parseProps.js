const { decompressFromEncodedURIComponent } = require('lz-string');
const axios = require('axios');
const fanart = require('./fanart');
const anilist = require('../lib/anilist');
const tvdb = require('../lib/tvdb');
const tmdb = require('../lib/getTmdb');
const imdb = require('../lib/imdb');
const { resolveAllIds } = require('../lib/id-resolver');
const idMapper = require('../lib/id-mapper');
const { selectFanartImageByLang } = require('./fanart');
const { getImdbRating } = require('../lib/getImdbRating');
const consola = require('consola');
const { cacheWrapMetaSmart } = require('../lib/getCache');
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
 * Normalizes a string for searching:
 * - Converts to lowercase
 * - Removes accents and diacritics
 * - Removes non-alphanumeric characters (except whitespace)
 * - Removes a leading "the "
 */
function normalize(str) {
  if (!str) return '';
  return str
    .normalize("NFD") 
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/^the\s+/, "")
    .trim();
}

/**
 * Calculates the Levenshtein distance between two strings.
 * This implementation is optimized to use only two rows of the matrix to save memory.
 * @param {string} s1 The first string.
 * @param {string} s2 The second string.
 * @returns {number} The edit distance between the two strings.
 */
function levenshteinDistance(s1, s2) {
  if (s1.length < s2.length) {
    return levenshteinDistance(s2, s1);
  }
  if (s2.length === 0) {
    return s1.length;
  }

  let previousRow = Array.from({ length: s2.length + 1 }, (_, i) => i);

  for (let i = 0; i < s1.length; i++) {
    let currentRow = [i + 1];
    for (let j = 0; j < s2.length; j++) {
      let insertions = previousRow[j + 1] + 1;
      let deletions = currentRow[j] + 1;
      let substitutions = previousRow[j] + (s1[i] !== s2[j]);
      currentRow.push(Math.min(insertions, deletions, substitutions));
    }
    previousRow = currentRow;
  }
  
  return previousRow[previousRow.length - 1];
}

/**
 * Calculates a similarity score between 0 and 1 based on Levenshtein distance.
 * @param {string} s1 The first string.
 * @param {string} s2 The second string.
 * @returns {number} A similarity score from 0.0 (completely different) to 1.0 (identical).
 */
function calculateSimilarity(s1, s2) {
  const maxLength = Math.max(s1.length, s2.length);
  if (maxLength === 0) return 1.0; // Both are empty
  const distance = levenshteinDistance(s1, s2);
  return 1.0 - distance / maxLength;
}


function sortSearchResults(results, query) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return results;

  const queryWords = normalizedQuery.split(/\s+/).filter((w) => w);
  const personMatchCount = results.filter(
    (r) => r.matchType === "person"
  ).length;
  const titleMatchCount = results.length - personMatchCount;
  const isPersonSearchIntent =
    personMatchCount > titleMatchCount && personMatchCount > 5;

  // 1. DECORATE
  const processedResults = results.map((item) => {
    const title = normalize(item.name || item.title || "");
    const score = Math.round((item.popularity || item.score || 0) * 10) / 10;
    const voteCount = item.vote_count || 0;

    const rawYearString = item.release_date || item.first_air_date;
    const year = rawYearString
      ? parseInt(rawYearString.substring(0, 4), 10) || 0
      : 0;

    const isPersonMatch = item.matchType === "person" && isPersonSearchIntent;

    // Exact should be literal string equality, regardless of quality
    const isExact = title === normalizedQuery;

    // 1. Truly established classic → huge vote count alone proves it
    const isEstablishedClassic = voteCount >= 1000;

    // 2. Solid mainstream hit → decent votes + some current engagement
    const isStandardHit =
      voteCount >= 200 && score >= 2.0 && year >= new Date().getFullYear() - 15; // only within ~15 years

    // 3. Recent up-and-comer → early traction, but still has to show signs of life
    const isRecentUpAndComer =
      item.year &&
      item.year >= new Date().getFullYear() - 2 &&
      voteCount >= 50 &&
      score >= 1.5;

    const passesExactQuality =
      isEstablishedClassic || isStandardHit || isRecentUpAndComer;

    // Start/Contains logic tightened
    const startsWith =
      !isExact && !isPersonMatch && title.startsWith(normalizedQuery);

    const contains =
      !isExact &&
      !isPersonMatch &&
      !startsWith &&
      queryWords.every((word) => title.includes(word));

    const similarity = calculateSimilarity(title, normalizedQuery);

    let matchReason = "Other";
    if (isExact && passesExactQuality) matchReason = "ExactHQ";
    else if (isExact) matchReason = "Exact";
    else if (isPersonMatch) matchReason = "Person";
    else if (startsWith) matchReason = "StartsWith";
    else if (contains) matchReason = "Contains";

    return {
      originalItem: item,
      title,
      score,
      voteCount,
      voteAverage: item.vote_average || 0,
      year: year,
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
    OTHER: { MIN_VOTES: 20, MIN_POPULARITY: 2.0 },
    OBSCURE: {
      AGE_CUTOFF: 20, 
      MAX_POPULARITY: 0.5,
      MAX_VOTES: 5,
    },
  };

  // Perform the primary filtering. Use `let` so we can overwrite it with the safety net if needed.
  let filteredResults = processedResults.filter((item) => {

    // --- Stage 1: Priority Pass (Always-Keep Rules) ---
    // These items are so important they bypass all other checks.

    //Give free pass to fighting events
    const isFightingEvent = /^(?=.*\b(UFC|LFA|PFL|Bellator)\b)(?=.*\b\w+\s+vs\.?\s+\w+\b).*/i.test(item.title);

    const isPriorityItem =
      (item.isExact && item.passesExactQuality) ||
      item.isPersonMatch ||
      isFightingEvent ||
      item.voteCount >= RULES.HQ_VOTE_THRESHOLD ||
      item.score >= RULES.HQ_POPULARITY_THRESHOLD;

    if (isPriorityItem) {
      return true;
    }

    // --- Stage 2: Hard Fail (Universal Rejection Rules) ---
    // These items have fundamental data quality issues and are always rejected.
    const isMissingCoreData =
      !item.year || item.year === 0 || !item.poster_path;

    // Check for content that is verifiably old and has no engagement.
    const isObscureContent =
      item.year < (RULES.CURRENT_YEAR - RULES.OBSCURE.AGE_CUTOFF) &&
      item.score < RULES.OBSCURE.MAX_POPULARITY &&
      item.voteCount < RULES.OBSCURE.MAX_VOTES;

    if (isMissingCoreData || isObscureContent) {
      return false;
    }

    // --- Stage 3: (Case-by-Case Rules) ---
    switch (item.matchReason) {
      case "Exact": // A low-quality Exact match
        const isRecent =
          item.year >= RULES.CURRENT_YEAR - RULES.LQ_EXACT.RECENT_YEAR_SPAN;
        const hasBasicEngagement =
          item.voteCount >= RULES.LQ_EXACT.MIN_VOTES ||
          item.score >= RULES.LQ_EXACT.MIN_POPULARITY;
        const hasAnyRecentEngagement =
          isRecent && (item.voteCount > 0 || item.score > 0);
        return hasBasicEngagement || hasAnyRecentEngagement;

      case "StartsWith":
        const isCurrentYear = item.year === RULES.CURRENT_YEAR;
        if (isCurrentYear) {
          return (
            item.voteCount >= RULES.STARTS_WITH.CURRENT_YEAR_MIN_VOTES ||
            item.score >= RULES.STARTS_WITH.CURRENT_YEAR_MIN_POPULARITY
          );
        }
        return (
          item.voteCount >= RULES.STARTS_WITH.MIN_VOTES ||
          item.score >= RULES.STARTS_WITH.MIN_POPULARITY
        );

      case "Contains":
        return (
          item.voteCount >= RULES.CONTAINS.MIN_VOTES &&
          item.similarity >= RULES.CONTAINS.MIN_SIMILARITY
        );
      
      case "Other":
        return (
          item.voteCount >= RULES.OTHER.MIN_VOTES &&
          item.score >= RULES.OTHER.MIN_POPULARITY
        );

      default:
        // By default, if a reason is not handled, we reject it
        return false;
    }
  });

  // --- Stage 4: Safety Net Fallback ---
  // If our strict filtering removed everything, this block ensures the user still sees the
  // most relevant possible results instead of an empty screen.
  if (filteredResults.length === 0 && processedResults.length > 0) {
    logger.warn(
      "⚠️ Filtering removed all results. Falling back to top 3 most popular."
    );

    // We sort the original, unfiltered list to *select* the top 3 candidates.
    filteredResults = [...processedResults]
      .sort((a, b) => {
        // Sort primarily by popularity score, then by vote count as a tie-breaker.
        if (a.score !== b.score) return b.score - a.score;
        return b.voteCount - b.voteCount;
      })
      .slice(0, 3); // Take only the top 3.
  }

  // 5. SORT
  filteredResults.sort((a, b) => {
    // If this is a person search, sort purely by popularity → votes
    if (isPersonSearchIntent) {
      if (a.score !== b.score) return b.score - a.score;
      if (a.voteCount !== b.voteCount) return b.voteCount - a.voteCount;
      if (a.year !== b.year) return b.year - a.year;
      return 0;
    }

    // Helper function to assign a priority tier based on match type.
    // Higher numbers are better and will be sorted first.
    const getTier = (item) => {
      switch (item.matchReason) {
        case "ExactHQ":
        case "Person":
          return 3; // Tier 1: Highest priority for confirmed high-quality results.
        case "Exact":
        case "StartsWith":
        case "Contains":
          return 2; // Tier 2: All other text matches, to be sorted by quality metrics.
        case "Other":
        default:
          return 1; // Tier 3: Lowest priority.
      }
    };

    const aTier = getTier(a);
    const bTier = getTier(b);

    // 1. PRIMARY SORT: By tier. If tiers are different, the sort is decided.
    if (aTier !== bTier) {
      return bTier - aTier;
    }

    // 2. TIE-BREAKERS: If items are in the same tier, sort by other metrics.
    // This provides logical ordering within each priority group.

    // Then popularity/score
    if (a.score !== b.score) return b.score - a.score;
    if (a.voteCount !== b.voteCount) return b.voteCount - a.voteCount;

    // Then similarity (especially useful for StartsWith/Contains)
    if (a.similarity !== b.similarity) return b.similarity - a.similarity;

    // Then by average rating (if enough votes exist)
    const minVotesForAverageComparison = 50;
    if (
      a.voteCount >= minVotesForAverageComparison &&
      b.voteCount >= minVotesForAverageComparison &&
      a.voteAverage !== b.voteAverage
    ) {
      return b.voteAverage - a.voteAverage;
    }

    // Finally, by newer year
    if (a.year !== b.year) return b.year - a.year;

    return 0;
  });

// 6. LOGGING (debug only)
  if (isDebugEnabled) {
    logger.debug(
      `Intent: ${
        isPersonSearchIntent ? "Persons" : "Title"
      } | Query: "${query}" | Raw Matches: ${processedResults.length}`
    );

    // Helper for table formatting is only needed for debugging.
    const formatForTable = (item) => ({
      Title: item.title.substring(0, 35),
      Year: item.year || "----",
      Pop: item.score.toFixed(1),
      Votes: item.voteCount,
      Sim: item.similarity.toFixed(2),
      Reason: item.matchReason,
    });

    // Log final filtered results (top 20)
    if (filteredResults.length > 0) {
      logger.debug("✅ FINAL SORTED RESULTS (Top 20):");
      console.table(
        filteredResults.slice(0, 20).map((item) => formatForTable(item))
      );
    }

    // The calculation of filtered-out items is expensive and should only happen in debug mode.
    const filteredOutItems = processedResults.filter(
      (item) => !filteredResults.includes(item)
    );

    if (filteredOutItems.length > 0) {
      logger.debug("❌ ITEMS FILTERED OUT (Top 20):");
      console.table(
        filteredOutItems.slice(0, 20).map((item) => formatForTable(item))
      );
    }
  }

  // Return original items
  return filteredResults.map((p) => p.originalItem);
}

function parseMedia(el, type, genreList = [], config = {}) {
  const genres = Array.isArray(el.genre_ids) && genreList.length > 0
    ? el.genre_ids.map(genreId => (genreList.find((g) => g.id === genreId) || {}).name).filter(Boolean)
    : el?.genres ? parseGenres(el.genres) : [];

  let name = type === 'movie' ? el.title : el.name;

  if(el.translations){
    el.overview = processOverviewTranslations(el.translations, config.language, el.overview);
    name = processTitleTranslations(el.translations, config.language, name);
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
    releaseInfo: type === 'movie' ? (el.release_date?.substring(0, 4) || '') : (el.first_air_date?.substring(0, 4) || ''),
    description: addMetaProviderAttribution(el.overview, 'TMDB', config),
    popularity: el.popularity, 
    vote_average: el.vote_average || 0,
    vote_count: el.vote_count || 0,
    matchType: el.matchType || 'title',
  };
}

function processOverviewTranslations(translations, language, overview) {
  if(language === 'pt-PT'){
    let translation = tmdb.getTranslations(translations, 'pt-PT');
      if(translation && translation.data.overview && translation.data.overview.trim() !== ''){
        overview = translation.data.overview;
      } else {
        if(!overview || overview.trim() === ''){
          translation = tmdb.getTranslations(translations, 'pt-BR');
          if(translation && translation.data.overview && translation.data.overview.trim() !== ''){
            overview = translation.data.overview;
          }
          if(!overview || overview.trim() === ''){
            translation = tmdb.getTranslations(translations, 'en-US');
            if(translation && translation.data.overview && translation.data.overview.trim() !== ''){
              overview = translation.data.overview;
            }
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

function processTitleTranslations(translations, language, title) {
  // Handle title fallback for pt-PT language
  if(language === 'pt-PT'){
    let translation = tmdb.getTranslations(translations, 'pt-PT');
    if(translation && translation.data.title && translation.data.title.trim() !== ''){
      title = translation.data.title;
    } else {
      if(!title || title.trim() === ''){
        translation = tmdb.getTranslations(translations, 'pt-BR');
        if(translation && translation.data.title && translation.data.title.trim() !== ''){
          title = translation.data.title;
        }
        if(!title || title.trim() === ''){
          translation = tmdb.getTranslations(translations, 'en-US');
          if(translation && translation.data.title && translation.data.title.trim() !== ''){
            title = translation.data.title;
          }
        }
      }
    }
  } else {
    let translation = tmdb.getTranslations(translations, language);
    if(translation && translation.data.title && translation.data.title.trim() !== ''){
      title = translation.data.title;
    } else {
      translation = tmdb.getTranslations(translations, 'en-US');
      if(translation && translation.data.title && translation.data.title.trim() !== ''){
        title = translation.data.title;
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
    if (!genre || !genre.name) return null;

    let searchUrl;
    const genreId = genre.mal_id;
    if (!genreId) return null;
    let url = `stremio:///discover/${encodeURIComponent(
      manifestUrl
    )}/anime/mal.genres?genre=${genre.name}`;
    if (type === 'movie') {
      url += `&type_filter=movie`;
    } else if (type === 'series') {
      url += `&type_filter=tv`;
    }
    searchUrl = url;

    return {
      name: genre.name,
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
  if (status === "Ended" && last_air_date) {
    const endYear = last_air_date.substring(0, 4);
    return startYear === endYear ? startYear : `${startYear}-${endYear}`;
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
  tvdbId = tvdbId || mapping?.thetvdb_id;
  tmdbId = tmdbId || mapping?.themoviedb_id;
  imdbId = imdbId || mapping?.imdb_id;
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
  
  if (config.apiKeys.fanart) {
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
  if (config.apiKeys.fanart) {
    let fanartUrl = null;
    if (mediaType === 'series' && tvdbId) {
      const images = await fanart.getShowImages(tvdbId, config);
      const logo = selectFanartImageByLang(images?.hdtvlogo, config);
      fanartUrl = logo?.url;
    } else if (mediaType === 'movie' && tmdbId) {
      const images = await fanart.getMovieImages(tmdbId, config);
      const logo = selectFanartImageByLang(images?.hdmovielogo, config);
      fanartUrl = logo?.url;
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
  if (config.apiKeys.fanart) {
    let fanartUrl = null;
    console.log(`[getAnimePoster] Fetching background for ${mediaType} with TVDB ID: ${tvdbId}, TMDB ID: ${tmdbId}`);
    if (mediaType === 'series' && tvdbId) {
      const images = await fanart.getShowImages(tvdbId, config);
      const poster = selectFanartImageByLang(images?.tvposter, config);
      fanartUrl = poster?.url;
    } else if (mediaType === 'movie' && (imdbId || tmdbId)) {
      const images = await fanart.getMovieImages(imdbId || tmdbId, config);
      const poster = selectFanartImageByLang(images?.movieposter, config);
      fanartUrl = poster?.url;
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
  let finalPosterUrl = malPosterUrl || `https://artworks.thetvdb.com/banners/images/missing/series.jpg`;
  
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
  const imdbRating = await getImdbRating(imdbId, stremioType);
  //const metaType = (kitsuId || imdbId) ? stremioType : 'anime';
  if (config.apiKeys?.rpdb) {

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
    description: descriptionFallback || anime.synopsis,
    year: anime.year,
    imdb_id: mapping?.imdb_id,
    releaseInfo: anime.year,
    imdbRating: imdbRating,
    runtime: parseRunTime(anime.duration),
    isAnime: true,
    trailers: trailers,
    trailerStreams: trailerStreams
  };
}

/**
 * Batch version of parseAnimeCatalogMeta that uses AniList batch fetching for better performance
 */
async function parseAnimeCatalogMetaBatch(animes, config, language) {
  if (!animes || animes.length === 0) return [];

  const artProvider = resolveArtProvider('anime', 'poster', config);
  const useAniList = artProvider === 'anilist';
  const useTvdb = artProvider === 'tvdb';
  const useImdb = artProvider === 'imdb';
  const useTmdb = artProvider === 'tmdb';
  const useFanart = (artProvider === 'fanart' && !!config.apiKeys?.fanart);
  //console.log(`[parseAnimeCatalogMetaBatch] Art provider: ${artProvider}, useAniList: ${useAniList}, useTvdb: ${useTvdb}, useTmdb: ${useTmdb}`);
  
  // Extract MAL IDs and try to get AniList IDs from mappings
  const malIds = animes.map(anime => anime.mal_id).filter(id => id && typeof id === 'number' && id > 0);
  let anilistArtworkMap = new Map();
  
  if (useAniList && malIds.length > 0) {
    try {
      //console.log(`[parseAnimeCatalogMetaBatch] Fetching AniList artwork for ${malIds.length} anime in batch`);
      //console.log(`[parseAnimeCatalogMetaBatch] MAL IDs: ${malIds.slice(0, 10).join(', ')}${malIds.length > 10 ? '...' : ''}`);
      
      // First, try to get AniList IDs from mappings
      const malToAnilistMap = new Map();
      const anilistIds = [];
      const malIdsWithoutAnilist = [];
      
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

  // Process each anime
  const results = await Promise.all(animes.map(async anime => {
    if (!anime || !anime.mal_id) return null;

    const malId = anime.mal_id;
    const stremioType = anime.type?.toLowerCase() === 'movie' ? 'movie' : 'series';
    const preferredProvider = config.providers?.anime || 'mal';

    const mapping = idMapper.getMappingByMalId(malId);
    /*if(mapping && !mapping.imdb_id && mapping.themoviedb_id){
      const allIds = await resolveAllIds(mapping.themoviedb_id, stremioType, config, {}, ['imdb']);
      mapping.imdb_id = allIds?.imdbId;
    }*/
    let id = `mal:${malId}`;
    if (preferredProvider === 'tvdb') {
      if (mapping && mapping.imdb_id) {
        id= `${mapping.imdb_id}`;
      }
    } else if (preferredProvider === 'tmdb') {
      if (mapping && mapping.imdb_id) {
        id = `${mapping.imdb_id}`;
      }
    } else if (preferredProvider === 'imdb') {
      if (mapping && mapping.imdb_id) {
        id= `${mapping.imdb_id}`;
      }
    } 
    
    const malPosterUrl = anime.images?.jpg?.large_image_url;
    let finalPosterUrl = malPosterUrl || `https://artworks.thetvdb.com/banners/images/missing/series.jpg`;
    
    // Use batch-fetched AniList artwork if available
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
    
    // Check for TVDB poster if configured as art provider
    if (useTvdb && mapping && mapping.thetvdb_id) {
      try {
        // Use the appropriate TVDB function based on media type
        const tvdbPoster = await tvdb.getSeriesPoster(mapping.thetvdb_id, config);
        
        if (tvdbPoster) {
          //console.log(`[parseAnimeCatalogMetaBatch] Using TVDB poster for MAL ID: ${malId} (TVDB ID: ${mapping.thetvdb_id}, Type: ${stremioType})`);
          finalPosterUrl = tvdbPoster;
        }
      } catch (error) {
        console.warn(`[parseAnimeCatalogMetaBatch] TVDB poster fetch failed for MAL ID ${malId}:`, error.message);
      }
    }
    
    // Check for TMDB poster if configured as art provider
    if (useTmdb && mapping && mapping.themoviedb_id) {
      try {
        // Use TMDB poster for anime
        const tmdbPoster = stremioType === 'movie' 
          ? await tmdb.getTmdbMoviePoster(mapping.themoviedb_id, config)
          : await tmdb.getTmdbSeriesPoster(mapping.themoviedb_id, config);
        
        if (tmdbPoster) {
          //console.log(`[parseAnimeCatalogMetaBatch] Using TMDB poster for MAL ID: ${malId} (TMDB ID: ${mapping.themoviedb_id}, Type: ${stremioType})`);
          finalPosterUrl = tmdbPoster;
        }
      } catch (error) {
        console.warn(`[parseAnimeCatalogMetaBatch] TMDB poster fetch failed for MAL ID ${malId}:`, error.message);
      }
    }

    if (useImdb && mapping && mapping.imdb_id) {
      try {
        finalPosterUrl = imdb.getPosterFromImdb(mapping.imdb_id);
      } catch (error) {
        console.warn(`[parseAnimeCatalogMetaBatch] IMDB poster fetch failed for MAL ID ${malId}:`, error.message);
      }
    }
    //console.log(`[parseAnimeCatalogMetaBatch] useFanart: ${useFanart} mapping: ${JSON.stringify(mapping)}`);
    if (useFanart && mapping) {
      try {
        if(mapping.themoviedb_id && stremioType === 'movie') {
          const images = await fanart.getMovieImages(mapping.themoviedb_id, config);
          const poster = selectFanartImageByLang(images?.movieposter, config);
          if (poster) {
            finalPosterUrl = poster.url;
          }
        } else if (mapping.imdb_id && stremioType === 'movie') {
          const images = await fanart.getMovieImages(mapping.imdb_id, config);
          const poster = selectFanartImageByLang(images?.movieposter, config);
          if (poster) {
            finalPosterUrl = poster.url;
          }
        } else if (mapping.thetvdb_id && stremioType === 'series') {
          const images = await fanart.getShowImages(mapping.thetvdb_id, config);
          const poster = selectFanartImageByLang(images?.tvposter, config);
          if (poster) {
            finalPosterUrl = poster.url;
          }
        }
      } catch (error) {
        console.warn(`[parseAnimeCatalogMetaBatch] Fanart poster fetch failed for MAL ID ${malId}:`, error.message);
      }
    }
    
    if (config.apiKeys?.rpdb) {
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
    const imdbId = mapping?.imdb_id;
    const tmdbId = mapping?.themoviedb_id;
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
    if(config.mal?.useImdbIdForCatalogAndSearch && stremioType === 'series'){
      return (await cacheWrapMetaSmart(config.userUUID, id, async () => {
        const { getMeta } = await import("../lib/getMeta");
        return await getMeta(stremioType, language, `mal:${malId}`, config, config.userUUID, false);
      }, undefined, {enableErrorCaching: true, maxRetries: 2}, stremioType))?.meta || null;
    }
    else {
      return {
        id: `mal:${malId}`,
        type: stremioType,
        logo: stremioType === 'movie' ? await tmdb.getTmdbMovieLogo(tmdbId, config) : await tmdb.getTmdbSeriesLogo(tmdbId, config),
        name: anime.title_english || anime.title,
        poster: finalPosterUrl,
        description: addMetaProviderAttribution(anime.synopsis, 'MAL', config),
        year: anime.year,
        imdb_id: mapping?.imdb_id,
        releaseInfo: anime.year,
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
        const images = await fanart.getMovieImages(tmdbId, config);
        const poster = selectFanartImageByLang(images?.movieposter, config);
        if (poster) {
          console.log(`[getMoviePoster] Found Fanart.tv poster for movie (TMDB ID: ${tmdbId}, lang: ${poster.lang})`);
          return poster.url;
        }
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const images = await fanart.getMovieImages(mappedIds.tmdbId, config);
          const poster = selectFanartImageByLang(images?.movieposter, config);
          if (poster) {
            console.log(`[getMoviePoster] Found Fanart.tv poster via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId}, lang: ${poster.lang})`);
            return poster.url;
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
        const images = await fanart.getMovieImages(tmdbId, config);
        const bg = selectFanartImageByLang(images?.moviebackground, config);
        if (bg) {
          console.log(`[getMovieBackground] Found Fanart.tv background for movie (TMDB ID: ${tmdbId}, lang: ${bg.lang})`);
          return bg.url;
        }
      }
      else {
        if(!tvdbId) return fallbackBackgroundUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const images = await fanart.getMovieImages(mappedIds.tmdbId, config);
          const bg = selectFanartImageByLang(images?.moviebackground, config);
          if (bg) {
            console.log(`[getMovieBackground] Found Fanart.tv background via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId}, lang: ${bg.lang})`);
            return bg.url;
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
        const images = await fanart.getMovieImages(tmdbId, config);
        const logo = selectFanartImageByLang(images?.hdmovielogo, config);
        if (logo) {
          console.log(`[getMovieLogo] Found Fanart.tv logo for movie (TMDB ID: ${tmdbId}, lang: ${logo.lang})`);
          return logo.url;
        }
      }
      else {
        if(!tvdbId) return fallbackLogoUrl;
        const mappedIds = await resolveAllIds(`tvdb:${tvdbId}`, 'movie', config);
        if(mappedIds.tmdbId) {
          const images = await fanart.getMovieImages(mappedIds.tmdbId, config);
          const logo = selectFanartImageByLang(images?.hdmovielogo, config);
          if (logo) {
            console.log(`[getMovieLogo] Found Fanart.tv logo via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId}, lang: ${logo.lang})`);
            return logo.url;
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
        const images = await fanart.getShowImages(tvdbId, config);
        const poster = selectFanartImageByLang(images?.tvposter, config);
        if (poster) {
          return poster.url;
        }
      }
      else if(tmdbId) {
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config, null, ['tvdb']);
        if(mappedIds.tvdbId) {
          const images = await fanart.getShowImages(mappedIds.tvdbId, config);
          const poster = selectFanartImageByLang(images?.tvposter, config);
          if (poster) {
              return poster.url;
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
        const images = await fanart.getShowImages(tvdbId, config);
        const bg = selectFanartImageByLang(images?.showbackground, config);
        if (bg) {
          console.log(`[getSeriesBackground] Found Fanart.tv background for series (TVDB ID: ${tvdbId}, lang: ${bg.lang})`);
          return bg.url;
        }
      } else if(tmdbId) {
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config);
        if(mappedIds.tvdbId) {
          const images = await fanart.getShowImages(mappedIds.tvdbId, config);
          const bg = selectFanartImageByLang(images?.showbackground, config);
          if (bg) {
            console.log(`[getSeriesBackground] Found Fanart.tv background via ID mapping for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId}, lang: ${bg.lang})`);
            return bg.url;
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
        const images = await fanart.getShowImages(tvdbId, config);
        const logo = selectFanartImageByLang(images?.hdtvlogo, config);
        if (logo) {
          //console.log(`[getSeriesLogo] Found Fanart.tv logo for series (TVDB ID: ${tvdbId}, lang: ${logo.lang})`);
          return logo.url;
        }
      }
      else if(tmdbId) {
        const mappedIds = await resolveAllIds(`tmdb:${tmdbId}`, 'series', config, null, ['tvdb']);
        if(mappedIds.tvdbId) {
          console.log(`[getSeriesLogo] Fetching Fanart.tv logo for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          const images = await fanart.getShowImages(mappedIds.tvdbId, config);
          const logo = selectFanartImageByLang(images?.hdtvlogo, config);
          if (logo) {
            //console.log(`[getSeriesLogo] Found Fanart.tv logo for series (TVDB ID: ${tvdbId}, lang: ${logo.lang})`);
            return logo.url;
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
        const tmdbLogo = await tmdb.tvImages({ id: tmdbId }, config).then(res => {
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
          const tmdbLogo = await tmdb.tvImages({ id: mappedIds.tmdbId }, config).then(res => {
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
  
  // Sort by vote_average descending
  const sorted = images.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
  return (
    sorted.find(img => img[key] === targetLang) ||
    sorted.find(img => img[key] === 'en') ||
    sorted[0]
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
  genSeasonsString
};
