require("dotenv").config();
const { MovieDb } = require("moviedb-promise");
const { getGenreList } = require("./getGenreList");
const Utils = require("../utils/parseProps");
const tvdb = require("./tvdb");
const { getImdbRating } = require("./getImdbRating");
const { to3LetterCode } = require("./language-map"); 
const jikan = require('./mal');
const moviedb = require('./getTmdb');
const imdb = require('./imdb');
const tvmaze = require('./tvmaze');
const idMapper = require('./id-mapper');
const kitsu = require('./kitsu');
const { resolveAllIds } = require('./id-resolver');
const { isAnime } = require("../utils/isAnime");
const { performGeminiSearch } = require('../utils/gemini-service');
const { filterMetasByRegex } = require('../utils/regexFilter');
const consola = require('consola');

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
  tag: 'Search'
});
const timingMetrics = require('./timing-metrics');
const { parse } = require("path");
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';


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


function getDefaultProvider(type) {
  if (type === 'movie') return 'tmdb.search';
  if (type === 'series') return 'tvdb.search';
  if (type === 'anime.movie') return 'mal.search.movie';
  if (type === 'anime.series') return 'mal.search.series';
  if (type === 'anime') return 'mal.search.series';
  return 'tmdb.search'; 
}

function sanitizeQuery(query) {
  if (!query) return '';
  return query.replace(/[\[\]()!?]/g, ' ').replace(/[:.-]/g, ' ').trim().replace(/\s\s+/g, ' ');
}

const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

const findArtwork = (artworks, type, lang, config) => {
  // If englishArtOnly is enabled, prefer English artwork first
  if (config?.artProviders?.englishArtOnly) {
    return artworks?.find(a => a.type === type && a.language === 'eng')?.image
      || artworks?.find(a => a.type === type)?.image;
  }
  // Otherwise use preferred language fallback
  return artworks?.find(a => a.type === type && a.language === lang)?.image
    || artworks?.find(a => a.type === type && a.language === 'eng')?.image
    || artworks?.find(a => a.type === type)?.image;
};

async function parseTvdbSearchResult(type, extendedRecord, language, config) {
  if (!extendedRecord || !extendedRecord.id || !extendedRecord.name) return null;

  const langCode = language.split('-')[0];
  const langCode3 = await to3LetterCode(langCode, config);
  const overviewTranslations = extendedRecord.translations?.overviewTranslations || [];
  const nameTranslations = extendedRecord.translations?.nameTranslations || [];
  const translatedName = nameTranslations.find(t => t.language === langCode3)?.name
                       || nameTranslations.find(t => t.language === 'eng')?.name
                       || extendedRecord.name;

  const overview = overviewTranslations.find(t => t.language === langCode3)?.overview
                   || overviewTranslations.find(t => t.language === 'eng')?.overview
                   || extendedRecord.overview;
  
  const tmdbId = extendedRecord.remoteIds?.find(id => id.sourceName === 'TheMovieDB.com')?.id;
  const imdbId = extendedRecord.remoteIds?.find(id => id.sourceName === 'IMDB')?.id;
  const tvmazeId = extendedRecord.remoteIds?.find(id => id.sourceName === 'TV Maze')?.id;
  const tvdbId = extendedRecord.id;
  logger.debug('Resolved IDs:', {tmdbId, imdbId, tvmazeId, tvdbId});
  
  const rawPosterUrl = findArtwork(extendedRecord.artworks, type === 'movie' ? 14 : 2, langCode3, config);

  const fallbackImage = `${host}/missing_poster.png`;
  const posterUrl = rawPosterUrl || fallbackImage;
  
  const validPosterUrl = posterUrl && typeof posterUrl === 'string' && !posterUrl.includes('undefined') && posterUrl !== 'null' ? posterUrl : fallbackImage;
  const posterProxyUrl = `${host}/poster/series/tvdb:${tvdbId}?fallback=${encodeURIComponent(validPosterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
  
  let certification = null;
  try {
    const langParts = language.split('-');
    const countryCode = langParts[1] || langParts[0];
    const contentType = type === 'movie' ? 'movie' : '';
    
    if (extendedRecord.contentRatings) {
      certification = getTvdbCertification(extendedRecord.contentRatings, countryCode, contentType);
    }
  } catch (error) {
    logger.warn(`Failed to get TVDB certification for ${type} ${tvdbId}:`, error.message);
  }
  
  let stremioId = `tvdb:${extendedRecord.id}`;
  if(imdbId) stremioId = imdbId;
  const logoUrl = findArtwork(extendedRecord.artworks, type === 'movie' ? 25 : 23, langCode3, config);
  const validLogoUrl = logoUrl && typeof logoUrl === 'string' && !logoUrl.includes('undefined') && logoUrl !== 'null' ? logoUrl : imdbId? imdb.getLogoFromImdb(imdbId) : null;
  
  return {
    id: stremioId,
    type: type,
    name: translatedName, 
    poster: config.apiKeys?.rpdb ? posterProxyUrl : validPosterUrl,
    _rawPosterUrl: rawPosterUrl, 
    year: extendedRecord.year,
    description: Utils.addMetaProviderAttribution(overview, 'TVDB', config),
    certification: certification,
    logo: validLogoUrl,
    genres: extendedRecord.genres?.map(g => g.name) || [],
    imdbRating: imdbId ? await getImdbRating(imdbId, type) : 'N/A',
    status: extendedRecord.status?.name || extendedRecord.status,
    aliases: extendedRecord.aliases || [],
    translations: extendedRecord.translations?.nameTranslations?.map(t => t.name) || [],
  };
}

async function performAnimeSearch(type, query, language, config, page = 1) {
  let searchResults = [];
  switch(type){
    case 'movie':
      logger.debug('Performing anime search for movie:', query);
      searchResults = await jikan.searchAnime('movie', query, 25, config, page);
      break;
    case 'series':
      const desiredTvTypes = config.mal?.useImdbIdForCatalogAndSearch ?  new Set(['tv', 'ona']) : new Set(['tv', 'ova', 'ona', 'tv special']);
      searchResults = await jikan.searchAnime('anime', query, 25, config, page);
      searchResults = searchResults.filter(item => {
        return typeof item?.type === 'string' && desiredTvTypes.has(item.type.toLowerCase());
      });
      break;
    default:
      const desiredTypes = new Set(['tv', 'movie', 'ova', 'ona', 'tv special']);
      searchResults = await jikan.searchAnime('anime', query, 25, config, page);
      searchResults = searchResults.filter(item => {
    return typeof item?.type === 'string' && desiredTypes.has(item.type.toLowerCase());
  });
      break;

  }
  
  // Early return if no search results
  if (!searchResults || searchResults.length === 0) {
    logger.info(`No anime results found for query: "${query}"`);
    return [];
  }
  
  logger.debug(`Found ${searchResults.length} anime results for query: "${query}"`);
  
  // Use batch processing for better performance and to avoid rate limits
  const metas = await Utils.parseAnimeCatalogMetaBatch(searchResults, config, language);
  //console.log(metas); 
  return metas;
}

async function performKitsuSearch(type, query, language, config, page = 1) {
  logger.debug(`Performing Kitsu search for ${type}:`, query);
  
  try {
    const KITSU_RATING_MAP = {
      'G': 'G',
      'PG': 'PG',
      'PG-13': 'PG-13',  
      'R': 'R',
      'NC-17': 'R18',
      'NONE': 'none'
    };
    const searchResults = await kitsu.searchByName(
      query,
      type === 'movie'
        ? ['movie']
        : ['tv','ona', 'ova', 'special'],
        KITSU_RATING_MAP[config.ageRating.toUpperCase()]
    );
    
    if (!searchResults || searchResults.length === 0) {
      logger.info(`No Kitsu results found for query: "${query}"`);
      return [];
    }
    
    logger.debug(`Found ${searchResults.length} Kitsu results for query: "${query}" of type ${type}`);
    
    // Parse Kitsu results into Stremio meta format
    const metas = await Promise.all(
      searchResults.map(async (item) => {
        try {
          const kitsuId = item.id;
          const mapping = await idMapper.getMappingByKitsuId(kitsuId);
          const imdbId = mapping?.imdb_id;
          const imdbRating = imdbId ? await getImdbRating(imdbId, type) : 'N/A';
          
          const background = await Utils.getAnimeBg({malId: mapping?.mal_id, imdbId: imdbId, tvdbId: mapping?.thetvdb_id, tmdbId: mapping?.themoviedb_id, mediaType: type === 'movie' ? 'movie' : 'series', malPosterUrl: item.coverImage?.original}, config);
          const poster = await Utils.getAnimePoster({malId: mapping?.mal_id, imdbId: imdbId, tvdbId: mapping?.thetvdb_id, tmdbId: mapping?.themoviedb_id, mediaType: type === 'movie' ? 'movie' : 'series', malPosterUrl: item.posterImage?.original}, config);
          const logo = type === 'movie' ? mapping?.themoviedb_id ? await moviedb.getTmdbMovieLogo(mapping?.themoviedb_id, config) : null : await Utils.getAnimeLogo({malId: mapping?.mal_id, imdbId: imdbId, tvdbId: mapping?.thetvdb_id, tmdbId: mapping?.themoviedb_id, mediaType: type === 'movie' ? 'movie' : 'series'}, config);
          return {
            id: `kitsu:${kitsuId}`,
            type: type === 'movie' ? 'movie' : 'series',
            name: Utils.getKitsuLocalizedTitle(item.titles, language) || item.canonicalTitle, 
            poster: type === 'movie' ? item.posterImage?.original : poster || `${host}/missing_poster.png`,
            logo: logo || null,
            background: type === 'movie' ? item.coverImage?.original : background || null,
            description: Utils.addMetaProviderAttribution(item.synopsis || item.description || '', 'Kitsu', config),
            genres: [], // Kitsu genres would need to be fetched separately
            year: item.startDate ? item.startDate.substring(0, 4) : null,
            imdbRating: imdbRating,
            status: item.status || 'unknown',
            episodeCount: item.episodeCount || null,
            runtime: Utils.parseRunTime(item.episodeLength),
            certification: item.ageRating,
          };
        } catch (error) {
          logger.error(`Error parsing Kitsu result for ${item.id}:`, error.message);
          return null;
        }
      })
    );
    
    return metas.filter(Boolean);
    
  } catch (error) {
    logger.error(`Kitsu search failed for "${query}":`, error.message);
    return [];
  }
}



/**
 * Normalizes a string for comparison by removing accents, diacritics, and converting to lowercase
 * @param {string} str - The string to normalize
 * @returns {string} - The normalized string
 */
function normalizeForComparison(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD') // Decompose combined characters
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^\w\s]/g, '') // Remove special characters except word chars and spaces
    .trim();
}

async function performTmdbSearch(type, query, language, config, searchPersons = true, page = 1) {
  const startTime = Date.now();
  const rawResults = new Map();
  logger.info(`Starting TMDB search for type "${type}" with query: "${query}"`);

  // STEP 1: GATHER ALL POTENTIAL IDs IN PARALLEL (from title search and person search)
  const addRawResult = (media) => {
      if (media && media.id && !rawResults.has(media.id)) {
          media.media_type = type === 'movie' ? 'movie' : 'tv';
          rawResults.set(media.id, media);
      }
  };

  const shouldSearchPersons = (() => {
    if (!searchPersons) return false; // Respect the explicit parameter
    
    // Check for symbols that are unlikely in a 'person''s name
    const nameInvalidatingSymbols = /[:()[\]?!$#@&]/;
    if (nameInvalidatingSymbols.test(query)) {
      logger.debug(`Skipping person search due to invalid symbols in query: "${query}"`);
      return false;
    }
    
    // If checks pass, it's plausible the user is searching for a person.
    return true;
  })();

  // Run the initial title search and person search concurrently
  const [titleRes, personCredits] = await Promise.all([
      type === 'movie'
          ? moviedb.searchMovie({ query, language, include_adult: config.includeAdult, page }, config)
          : moviedb.searchTv({ query, language, include_adult: config.includeAdult, page }, config),
      
      shouldSearchPersons
          ? moviedb.searchPerson({ query, language }, config).then(async personRes => {
              if (personRes.results?.length > 0) {
                const sortedPersons = personRes.results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
                const topPerson = sortedPersons[0];
                
                logger.debug(`Person found: ${topPerson.name} (popularity: ${topPerson.popularity || 0})`);
                
                // Fetch full person details to get also_known_as names
                const personDetails = await moviedb.personInfo({ id: topPerson.id, language }, config);
                
                const queryNormalized = normalizeForComparison(query);
                const personNameNormalized = normalizeForComparison(topPerson.name);
                const alsoKnownAs = personDetails.also_known_as || [];
                
                // Check if query matches the primary name
                const isExactMatch = personNameNormalized === queryNormalized;
                const isContainedWithPopularity = personNameNormalized.includes(queryNormalized) && (topPerson.popularity || 0) > 3;
                
                // Check if query matches any of the also_known_as names
                const matchesAlsoKnownAs = alsoKnownAs.some(aka => {
                  const akaNormalized = normalizeForComparison(aka);
                  return akaNormalized === queryNormalized || (akaNormalized.includes(queryNormalized) && (topPerson.popularity || 0) > 3);
                });
                
                if (!isExactMatch && !isContainedWithPopularity && !matchesAlsoKnownAs) {
                  logger.debug(`Skipping person ${topPerson.name} - query "${query}" doesn't match name or also_known_as (${alsoKnownAs.join(', ')}) with sufficient popularity (${topPerson.popularity || 0} <= 3)`);
                  return [];
                }
                
                logger.debug(`Person match confirmed: ${topPerson.name} (also known as: ${alsoKnownAs.join(', ')})`);
                
                const credits = type === 'movie'
                    ? await moviedb.personMovieCredits({ id: topPerson.id, language }, config)
                    : await moviedb.personTvCredits({ id: topPerson.id, language }, config);
                  // Combine cast and crew from the most relevant person
                  return [...(credits.cast || []), ...(credits.crew || [])];
              }
              return []; // Return empty array if no person is found
          })
          : Promise.resolve([]) // Return empty array if person search is disabled or filtered out
  ]);

  // Add all found items to our raw results map, tagging them by source
  if (titleRes?.results) {
    titleRes.results.forEach(media => {
        media.matchType = 'title'; // Tag as a direct title match
        addRawResult(media);
    });
  }
  personCredits.forEach(media => {
      media.matchType = 'person'; // Tag as a match from a person's filmography
      addRawResult(media);
  });
  // number of results from people search
  logger.debug(`TMDB gathered ${personCredits.length} unique potential results from people search in ${Date.now() - startTime}ms`);
  logger.debug(`TMDB gathered ${rawResults.size} unique potential results in ${Date.now() - startTime}ms`);
  const sortedRawResults = Utils.sortSearchResults(Array.from(rawResults.values()), query).slice(0, 25);

  // STEP 2: HYDRATE ALL RESULTS IN PARALLEL

  const hydrationPromises = sortedRawResults.map(async (media) => {
    try {
        const mediaType = media.media_type === 'movie' ? 'movie' : 'series';
        // Filter out items that don't match the search type (e.g., a movie found in an actor's TV credits)
        if(mediaType !== type) {
          logger.debug(`Filtering out ${media.title || media.name} - mediaType: ${mediaType}, searchType: ${type}`);
          return null;
        }

        let logoUrl; let backgroundUrl; let posterUrl;
        const langCode = language.split('-')[0]; 
        const imageLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
        // OPTIMIZATION: Fetch details, external_ids, certifications, and keywords in ONE call
        const details = mediaType === 'movie'
            ? await moviedb.movieInfo({ id: media.id, language, append_to_response: "external_ids,release_dates,images,translations,keywords, release_dates", include_image_language: imageLanguages }, config)
            : await moviedb.tvInfo({ id: media.id, language, append_to_response: "external_ids,content_ratings,images,translations,keywords", include_image_language: imageLanguages }, config);
        
        let allIds = {
            tmdbId: details.id,
            imdbId: details.external_ids?.imdb_id || details.imdb_id,
            tvdbId: details.external_ids?.tvdb_id
        };
        allIds = await resolveAllIds(`tmdb:${media.id}`, mediaType, config, allIds, ['imdb']);
        const selectedBg = details.images?.backdrops?.find(b => b.iso_639_1 === 'xx')
          || details.images?.backdrops?.find(b => b.iso_639_1 === null)
          || details.images?.backdrops?.find(b => b.iso_639_1 === language.split('-')[0])
          || details.images?.backdrops?.[0];
        const selectedLogo = Utils.selectTmdbImageByLang(details.images?.logos, config);
        const selectedPoster = Utils.selectTmdbImageByLang(details.images?.posters, config);
        const fallbackImage = `${host}/missing_poster.png`;
        logoUrl = selectedLogo?.file_path ? `https://image.tmdb.org/t/p/original${selectedLogo?.file_path}` : null;
        backgroundUrl = selectedBg?.file_path ? `https://image.tmdb.org/t/p/original${selectedBg?.file_path}` : null;
        posterUrl = selectedPoster?.file_path ? `https://image.tmdb.org/t/p/original${selectedPoster?.file_path}` : fallbackImage;

        // OPTIMIZATION: Fetch poster, rating, logo, and resolve final stremio ID in parallel
        const imdbRating = allIds.imdbId ? await getImdbRating(allIds.imdbId, mediaType) : null;
        
        // Debug: Check for malformed poster URLs
        if (!posterUrl || posterUrl === 'null' || posterUrl.includes('undefined')) {
          logger.warn(`Malformed poster URL for ${media.title || media.name}: ${posterUrl}`);
        }
        
        // Ensure we always have a valid poster URL
        const validPosterUrl = posterUrl && posterUrl !== 'null' && !posterUrl.includes('undefined') 
          ? posterUrl 
          : fallbackImage;
        
        const posterProxyUrl = `${host}/poster/${mediaType}/tmdb:${media.id}?fallback=${encodeURIComponent(validPosterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
        
        let stremioId = `tmdb:${media.id}`; // Default to TMDB
        if(allIds?.imdbId) stremioId = allIds.imdbId;
        
        // Assemble the final meta object
        const parsed = Utils.parseMedia(details, mediaType, [], config);
        if (!parsed) return null; // In case parsing fails
        parsed.id = stremioId;
        parsed.poster = config.apiKeys?.rpdb ? posterProxyUrl : validPosterUrl;
        parsed.imdbRating = imdbRating;
        parsed.logo = logoUrl;
        parsed.background = backgroundUrl;
        parsed.certification = mediaType === 'movie'
            ? Utils.getTmdbMovieCertificationForCountry(details.release_dates)
            : Utils.getTmdbTvCertificationForCountry(details.content_ratings);
        parsed.popularity = media.popularity;
        parsed.score = media.score;
        if(allIds.imdbId) parsed.imdb_id = allIds.imdbId;
        parsed.runtime = type === 'movie' ? Utils.parseRunTime(details.runtime) : null;
        if(type === 'series') parsed.runtime  = Utils.parseRunTime(details.episode_run_time?.[0] ?? details.last_episode_to_air?.runtime ?? details.next_episode_to_air?.runtime ?? null);
        parsed.app_extras = { releaseDates: details.release_dates };
        return { parsed, details }; // Return both for keyword filtering
    } catch (error) {
        logger.error(`Failed to hydrate TMDB item ${media.id} (${media.title || media.name}):`, error);
        return null;
    }
  });

  const hydratedResults = (await Promise.all(hydrationPromises)).filter(Boolean);
  logger.info(`Hydration complete in ${Date.now() - startTime}ms. Found ${hydratedResults.length} valid items.`);

  // STEP 3: KEYWORD FILTERING
  let keywordFilteredResults;
  if (config.includeAdult === false) {
    const adultKeywordBlacklist = ['porn', 'porno', 'soft porn', 'softcore', 'pinku-eiga'];
    logger.debug(`Filtering results with adult keyword blacklist as includeAdult is false.`);
    keywordFilteredResults = hydratedResults.filter(result => {
        const keywordsObject = result.details.keywords;
        if (!keywordsObject) {
            return true; // No keywords, can't filter, so we keep it.
        }

        // Keywords can be in `results` (for TV) or `keywords` (for movies)
        const keywords = keywordsObject.results || keywordsObject.keywords || [];
        
        for (const keyword of keywords) {
            const keywordName = keyword.name.toLowerCase();
            if (adultKeywordBlacklist.includes(keywordName)) {
                logger.info(`Item "${result.parsed.name}" was filtered because of keyword "${keyword.name}"`);
                return false; // Filter this item out
            }
        }
        return true; // Keep this item
    });
    logger.debug(`Keyword filtering applied: ${hydratedResults.length} -> ${keywordFilteredResults.length} results.`);
  } else {
    keywordFilteredResults = hydratedResults;
  }
  
  const hydratedMetas = keywordFilteredResults.map(result => result.parsed);

  // STEP 4: FINAL SORTING AND FILTERING
  let filteredResults = hydratedMetas;
  if (config.ageRating && config.ageRating.toLowerCase() !== 'none') {
      const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
      const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
      const movieToTvMap = { 'G': 'TV-G', 'PG': 'TV-PG', 'PG-13': 'TV-14', 'R': 'TV-MA', 'NC-17': 'TV-MA' };

      filteredResults = filteredResults.filter(result => {
          const cert = result.certification;
          
          // If rating is PG-13 or lower, exclude items without certification as they could be inappropriate
          const isTvRating = type === 'series';
          const userRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
          const isUserRatingRestrictive = userRating === 'PG-13' || 
                                         (movieRatingHierarchy.indexOf(userRating) !== -1 && 
                                          movieRatingHierarchy.indexOf(userRating) <= movieRatingHierarchy.indexOf('PG-13')) ||
                                         (tvRatingHierarchy.indexOf(userRating) !== -1 && 
                                          tvRatingHierarchy.indexOf(userRating) <= tvRatingHierarchy.indexOf('TV-14'));
          
          if (!cert || cert === "" || cert.toLowerCase() === 'nr') {
              return !isUserRatingRestrictive; // Exclude items without certification if user rating is restrictive
          }
          
          const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
          const userRatingIndex = ratingHierarchy.indexOf(userRating);
          const resultRatingIndex = ratingHierarchy.indexOf(cert);
          
          if (userRatingIndex === -1) return true;
          if (resultRatingIndex === -1) return true; // Allow items with unknown ratings
          
          return resultRatingIndex <= userRatingIndex;
      });
      logger.debug(`Age rating filter applied: ${hydratedMetas.length} -> ${filteredResults.length} results.`);
  }
  if (type === 'movie' && config.hideUnreleasedDigital) {
    const beforeCount = filteredResults.length;
    filteredResults = filteredResults.filter(meta => Utils.isReleasedDigitally(meta));
    const afterCount = filteredResults.length;
    if (beforeCount !== afterCount) {
      logger.info(`Digital release filter (TMDB): filtered out ${beforeCount - afterCount} unreleased movies`);
    }
  }

  logger.success(`Completed TMDB search for "${query}" in ${Date.now() - startTime}ms. Returning ${filteredResults.length} results.`);
  return filteredResults;
}


async function performAiSearch(type, query, language, config) {
  const geminiKey = config.apiKeys?.gemini;
  const aiSuggestions = await performGeminiSearch(geminiKey, query, type, language);
  if (!aiSuggestions || aiSuggestions.length === 0) {
    logger.info('Gemini returned no suggestions.');
    return [];
  }
  logger.debug('Gemini suggested:', JSON.stringify(aiSuggestions, null, 2));

  const finalMetas = [];
  const seenIds = new Set();

  for (const suggestion of aiSuggestions) {
    try {
      let parsedResult = null;

      if (type === 'anime') {
        const malId = suggestion.mal_id;
        if (malId) {
          const jikanData = await jikan.getAnimeDetails(malId);
          if (jikanData) {
            parsedResult = Utils.parseAnimeCatalogMeta(jikanData, config, language);
          }
        }
      } 
      else if (type === 'series') {
        const searchTitle = suggestion.title;
        if (searchTitle) {
          const searchStartTime = Date.now();
          logger.debug(`Starting TVDB series search for: "${searchTitle}"`);
          
          const searchResults = await tvdb.searchSeries(searchTitle, config);
          const searchTime = Date.now() - searchStartTime;
          logger.debug(`TVDB series search completed in ${searchTime}ms, found ${searchResults?.length || 0} results`);
          
          const topMatchId = searchResults?.[0]?.tvdb_id;
          if (topMatchId) {
            const extendedStartTime = Date.now();
            logger.debug(`Fetching TVDB extended data for series ID: ${topMatchId}`);
            
            const extendedRecord = await tvdb.getSeriesExtended(topMatchId, config);
            const extendedTime = Date.now() - extendedStartTime;
            logger.debug(`TVDB extended data fetched in ${extendedTime}ms`);
            
            parsedResult = await parseTvdbSearchResult(type, extendedRecord, language, config);
          }
        }
      } 
      /*else if (type === 'movie') {
        const searchTitle = suggestion.title;
        if (searchTitle) {
          const results = await performMovieSearch(type, searchTitle, language, config, false);
          parsedResult = results?.[0] || null;
        }
      }*/

      if (parsedResult && !seenIds.has(parsedResult.id)) {
        finalMetas.push(parsedResult);
        seenIds.add(parsedResult.id);
      }

    } catch (error) {
      const title = suggestion.title || suggestion.english_title || 'Unknown';
      logger.error(`Failed to process AI suggestion "${title}":`, error.message);
      continue; 
    }
  }

  return finalMetas;
}

async function performTvdbCollectionsSearch(query, language, config) {
  const sanitizedQuery = sanitizeQuery(query);
  if (!sanitizedQuery) return [];
  const langCode = language.split('-')[0];
  const langCode3 = await to3LetterCode(langCode, config);

  logger.info(`Starting TVDB collections search for: "${sanitizedQuery}"`);

  try {
    // Search for collections
    const collectionsResults = await tvdb.searchCollections(sanitizedQuery, config);
    
    if (!collectionsResults || collectionsResults.length === 0) {
      logger.info('No TVDB collections found for query.');
      return [];
    }

    logger.debug(`Found ${collectionsResults.length} collection results.`);

    // Parse collection results into metas
    const metas = await Promise.all(
      collectionsResults.map(async (collection) => {
        try {
          const collectionId = collection.tvdb_id || collection.id;
          if (!collectionId) return null;

          // Get collection details with translations
          let [details, translations] = await Promise.all([
            tvdb.getCollectionDetails(String(collectionId), config),
            tvdb.getCollectionTranslations(String(collectionId), langCode3, config)
          ]);

          if (!details) return null;

          const translatedName = translations?.name || details.name;
          const translatedOverview = translations?.overview || details.overview;

          return {
            id: `tvdbc:${collectionId}`,
            type: 'series', // Collections are typically series-focused
            name: translatedName || details.name,
            poster: details.image || collection.image_url,
            description: translatedOverview || details.overview || '',
            genres: [],
            releaseInfo: details.entities?.length ? `${details.entities.length} items` : ''
          };
        } catch (error) {
          logger.warn(`Error parsing collection ${collection.id}:`, error.message);
          return null;
        }
      })
    );

    const finalMetas = metas.filter(Boolean);
    logger.info(`Successfully parsed ${finalMetas.length} collections into Stremio metas.`);
    
    return finalMetas;
  } catch (error) {
    logger.error('Error in TVDB collections search:', error.message);
    return [];
  }
}

async function performTvdbSearch(type, query, language, config) {
  const sanitizedQuery = sanitizeQuery(query);
  if (!sanitizedQuery) return [];

  const idMap = new Map(); 

  // STEP 1: GATHER IDs FROM TITLE AND PEOPLE SEARCHES IN PARALLEL
  const searchStartTime = Date.now();
  logger.info(`Starting TVDB parallel search for: "${sanitizedQuery}"`);

  const shouldSearchPersons = (() => {
    
    // Check for symbols that are unlikely in a 'person''s name
    const nameInvalidatingSymbols = /[:()[\]?!$#@&]/;
    if (nameInvalidatingSymbols.test(query)) {
      logger.debug(`Skipping person search due to invalid symbols in query: "${query}"`);
      return false;
    }
    
    // If checks pass, it's plausible the user is searching for a person.
    return true;
  })();

  const [titleResults, peopleResults] = await Promise.all([
    type === 'movie' 
      ? tvdb.searchMovies(sanitizedQuery, config) 
      : tvdb.searchSeries(sanitizedQuery, config),
    shouldSearchPersons ? tvdb.searchPeople(sanitizedQuery, config) : Promise.resolve([])
  ]);

  logger.debug(`TVDB initial searches completed in ${Date.now() - searchStartTime}ms.`);

  (titleResults || []).forEach(result => {
    const resultId = result.tvdb_id || result.id;
    if (resultId) {
      idMap.set(String(resultId), type);
    }
  });
  
  // Process people results to find related movies/series
  if (peopleResults && peopleResults.length > 0) {
    const topPerson = peopleResults[0];
    try {
      const personDetails = await tvdb.getPersonExtended(topPerson.tvdb_id, config);
      if (personDetails && personDetails.characters) {
        personDetails.characters
          .filter(credit => credit.type === 3) // Filter for 'Actor' role type
          .forEach(credit => {
            const creditType = credit.seriesId ? 'series' : 'movie';
            const creditId = credit.seriesId || credit.movieId;
            // Only add if it matches the type we are searching for
            if (creditId && creditType === type) { 
              idMap.set(String(creditId), creditType);
            }
        });
      }
    } catch (e) {
      logger.warn(`Could not fetch person details for ${topPerson.name}:`, e.message);
    }
  }
  
  const uniqueIds = Array.from(idMap.keys());
  if (uniqueIds.length === 0) {
    logger.info('No unique TVDB IDs found after initial search.');
    return [];
  }
  logger.debug(`Found ${uniqueIds.length} unique TVDB IDs to fetch details for.`);

  // STEP 2: FETCH EXTENDED DETAILS FOR ALL UNIQUE IDs IN PARALLEL
  const detailPromises = uniqueIds.map(id => {
    return type === 'movie' 
      ? tvdb.getMovieExtended(id, config) 
      : tvdb.getSeriesExtended(id, config);
  });
  
  const detailedResults = (await Promise.allSettled(detailPromises))
    .filter(res => res.status === 'fulfilled' && res.value)
    .map(res => res.value); // Extract successful results
    
  logger.debug(`Successfully fetched extended details for ${detailedResults.length} items.`);

  // STEP 3: PARSE ALL DETAILED RESULTS INTO STREMIO METAS IN PARALLEL
  // We are now passing the fully detailed 'record' which contains aliases and translations
  const parsePromises = detailedResults.map(record =>
    parseTvdbSearchResult(type, record, language, config)
  );
    
  const finalResults = (await Promise.all(parsePromises)).filter(Boolean);
  logger.info(`Successfully parsed ${finalResults.length} items into Stremio metas.`);

  // Apply sorting and filtering
  const sortedResults = Utils.sortTvdbSearchResults(finalResults, sanitizedQuery);

  // STEP 4: APPLY AGE RATING FILTERING
  let ageFilteredResults = sortedResults;
  if (config.ageRating && config.ageRating.toLowerCase() !== 'none') {
    const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
    const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
    const movieToTvMap = { 'G': 'TV-G', 'PG': 'TV-PG', 'PG-13': 'TV-14', 'R': 'TV-MA', 'NC-17': 'TV-MA' };

    ageFilteredResults = sortedResults.filter(result => {
      const cert = result.certification;
      
      // If rating is PG-13 or lower, exclude items without certification as they could be inappropriate
      const isTvRating = type === 'series';
      const userRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
      const isUserRatingRestrictive = userRating === 'PG-13' || 
                                     (movieRatingHierarchy.indexOf(userRating) !== -1 && 
                                      movieRatingHierarchy.indexOf(userRating) <= movieRatingHierarchy.indexOf('PG-13')) ||
                                     (tvRatingHierarchy.indexOf(userRating) !== -1 && 
                                      tvRatingHierarchy.indexOf(userRating) <= tvRatingHierarchy.indexOf('TV-14'));
      
      if (!cert || cert === "" || cert.toLowerCase() === 'nr') {
        return !isUserRatingRestrictive; // Exclude items without certification if user rating is restrictive
      }
      
      const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
      const userRatingIndex = ratingHierarchy.indexOf(userRating);
      const resultRatingIndex = ratingHierarchy.indexOf(cert);
      
      if (userRatingIndex === -1) return true; // If user rating is invalid, don't filter
      if (resultRatingIndex === -1) return true; // Allow items with unknown ratings
      
      return resultRatingIndex <= userRatingIndex;
    });
    
    logger.debug(`TVDB filtered ${finalResults.length} results to ${ageFilteredResults.length} based on age rating: ${config.ageRating}`);
  }
  logger.info(`TVDB search results completed in ${Date.now() - searchStartTime}ms`);

  return ageFilteredResults;
}

async function performTvmazeSearch(query, language, config) {
  const sanitizedQuery = sanitizeTvmazeQuery(query);
  if (!sanitizedQuery) return [];

  const shouldSearchPersons = (() => {
    const nameInvalidatingSymbols = /[:()[\]?!$#@&]/;
    if (nameInvalidatingSymbols.test(query)) {
      logger.debug(`Skipping person search due to invalid symbols in query: "${query}"`);
      return false;
    }
    return true;
  })();

  const [titleResults, peopleResults] = await Promise.all([
    tvmaze.searchShows(sanitizedQuery),
    shouldSearchPersons ? tvmaze.searchPeople(sanitizedQuery) : Promise.resolve([])
  ]);
  
  const searchResults = new Map();
  const processedIds = new Set();
  
  const addResult = async (show, score = 0) => {
    const parsed = await parseTvmazeResult(show, config);
    if (parsed && show?.id && !processedIds.has(show.id)) {
      processedIds.add(show.id);
      searchResults.set(show.id, { ...parsed, _score: score });
    }
  };

  // Process title results in order (preserving TVMaze's relevance scoring)
  await Promise.all(titleResults.map(result => addResult(result.show, result.score)));

  // Process people results (these don't have scores, so we'll add them at the end)
  if (peopleResults.length > 0) {
    const personId = peopleResults[0].person.id;
    const castCredits = await tvmaze.getPersonCastCredits(personId);
    await Promise.all(castCredits.map(credit => addResult(credit._embedded.show, 0)));
  }
  
  if (searchResults.size > 0) {
    // Sort by score (highest first) and remove the _score property
    return Array.from(searchResults.values())
      .sort((a, b) => (b._score || 0) - (a._score || 0))
      .map(({ _score, ...result }) => result);
  }
  
  // --- TIER 2 & 3 FALLBACKS ---
  logger.info(`Initial searches failed for "${query}". Trying fallback tiers...`);
  /*const tvdbResults = await tvdb.search(query);
  if (tvdbResults.length > 0) {
    const topTvdbResult = tvdbResults[0];
    const tvdbId = topTvdbResult.tvdb_id;
    if (tvdbId) {
      const finalShow = await tvmaze.getShowByTvdbId(tvdbId);
      if (finalShow) return [parseTvmazeResult(finalShow)].filter(Boolean);
    }
  }*/
  
  const tmdbResults = await moviedb.searchTv({ query: query, language }, config);
  if (tmdbResults?.results?.length > 0) {
    const topTmdbResult = tmdbResults.results[0];
    const tmdbInfo = await moviedb.tvInfo({ id: topTmdbResult.id, append_to_response: 'external_ids' });
    const imdbId = tmdbInfo.external_ids?.imdb_id;
    if (imdbId) {
      const finalShow = await tvmaze.getShowByImdbId(imdbId);
      if (finalShow) return [parseTvmazeResult(finalShow, config)].filter(Boolean);
    }
  }

  return [];
}

function sanitizeTvmazeQuery(query) {
  if (!query) return '';
  return query.replace(/[\[\]()]/g, ' ').replace(/[:.-]/g, ' ').trim().replace(/\s\s+/g, ' ');
}

async function parseTvmazeResult(show, config) {
  if (!show || !show.id || !show.name) return null;

  const imdbId = show.externals?.imdb;
  const tvdbId = show.externals?.thetvdb;
  const tmdbId = show.externals?.themoviedb;
  // use preferred provider id as id. tvmaze are type series only.
  let stremioId = `tvmaze:${show.id}` ;
  if(imdbId) stremioId = imdbId;
  var fallbackImage = show.image?.original || `${host}/missing_poster.png`;
  const posterProxyUrl = imdbId ? `${host}/poster/series/${imdbId}?fallback=${encodeURIComponent(show.image?.original || '')}&lang=${show.language}&key=${config.apiKeys?.rpdb}`: `${host}/poster/series/tvdb:${tvdbId}?fallback=${encodeURIComponent(show.image?.original || '')}&lang=${show.language}&key=${config.apiKeys?.rpdb}`;
  const logoUrl = imdbId ? imdb.getLogoFromImdb(imdbId) : tvdbId ? await tvdb.getSeriesLogo(tvdbId, config) : null;
  return {
    id: stremioId,
    type: 'series',
    name: show.name,
    poster: config.apiKeys?.rpdb ? posterProxyUrl : fallbackImage,
    background: show.image?.original ? `${show.image.original}` : null,
    description: Utils.addMetaProviderAttribution(show.summary ? show.summary.replace(/<[^>]*>?/gm, '') : '', 'TVmaze', config),
    genres: show.genres || [],
    logo: logoUrl,
    year: show.premiered ? show.premiered.substring(0, 4) : '',
    imdbRating: imdbId ? (await getImdbRating(imdbId, 'series')) : show.rating?.average ? show.rating.average.toFixed(1) : 'N/A'
  };
}

// Helper function to determine provider from search ID
function getProviderFromSearchId(searchId) {
  if (searchId.includes('mal.')) {
    return 'mal';
  } else if (searchId.includes('kitsu.')) {
    return 'kitsu';
  } else if (searchId.includes('tmdb.')) {
    return 'tmdb';
  } else if (searchId.includes('tvdb.')) {
    return 'tvdb';
  } else if (searchId.includes('tvmaze.')) {
    return 'tvmaze';
  } else if (searchId === 'search') {
    // For generic 'search' case, we need to look at the actual provider used
    // This will be determined by the config.search.providers setting
    return 'search'; // Generic search - actual provider determined at runtime
  } else {
    return 'unknown';
  }
}

async function getSearch(id, type, language, extra, config) {
  const searchStartTime = Date.now();
  
  const queryText = extra?.search || extra?.genre_id || extra?.va_id || 'N/A';
  
  try {
    if (!extra) {
      logger.warn(`Search request for id '${id}' received with no 'extra' argument.`);
      return { metas: [] };
    }
    // Timing handled by logger.info at completion

    let metas = [];
     const pageSize = 25; 
    
    const page = extra.skip ? Math.floor(parseInt(extra.skip) / pageSize) + 1 : 1;
    switch (id) {
      case 'mal.genre_search':
        if (extra.genre_id) {
          const results = await jikan.getAnimeByGenre(extra.genre_id, extra.type_filter, page, config);
          metas = await Utils.parseAnimeCatalogMetaBatch(results, config, language);
        }
        break;
      
      case 'mal.va_search':
        if (extra.va_id) {
          const roles = await jikan.getAnimeByVoiceActor(extra.va_id);
          const animeResults = roles.map(role => role.anime);
          const batchMetas = await Utils.parseAnimeCatalogMetaBatch(animeResults, config, language);
          
          metas = batchMetas.map((meta, index) => {
            if (roles[index]) {
              meta.description = `Role: ${roles[index].character.name}`;
            }
            return meta;
          });
        }
        break;

      /*case 'mal.search.series':
        logger.debug(`Performing mal.search.series search for series: ${extra.search}`);
        if (extra.search) {
          metas = await performAnimeSearch('series', extra.search, language, config);
        }
        break;  
      case 'mal.search.movie':
        logger.debug(`Performing mal.search.movie search for movies: ${extra.search}`);
        if (extra.search) {
          metas = await performAnimeSearch('movie', extra.search, language, config);
        }
        break;*/

      case 'tvdb_collections_search':
        if (extra.search) {
          metas = await performTvdbCollectionsSearch(extra.search, language, config);
        }
        break;

      case 'search':
        if (extra.search) {
          const query = extra.search;
          let providerId;
          logger.info(`Performing search for type '${type}' with query '${query}'`);
          if (type === 'movie') {
            providerId = config.search?.providers?.movie;
          } else if (type === 'series') {
            providerId = config.search?.providers?.series;
          } else if (type === 'anime.movie') {
            providerId = config.search?.providers?.anime_movie;
          } else if (type === 'anime.series') {
            providerId = config.search?.providers?.anime_series;
          } else if (type === 'collection') {
            providerId = 'tvdb.collections.search';
          }
          
          providerId = providerId || getDefaultProvider(type);
          if (config.search?.ai_enabled && config.apiKeys?.gemini) {
            logger.info(`Performing AI-enhanced search for type '${type}'`);
            metas = await performAiSearch(type, query, language, config);
          } else {
            logger.debug(`Performing direct keyword search for type '${type}' using provider '${providerId}'`);

            switch (providerId) {
              case 'mal.search.series':
                metas = await performAnimeSearch('series', query, language, config, page);
                break;
              case 'mal.search.movie':
                metas = await performAnimeSearch('movie', query, language, config, page);
                break;
              case 'kitsu.search.series':
                metas = await performKitsuSearch('series', query, language, config, page);
                break;
              case 'kitsu.search.movie':
                metas = await performKitsuSearch('movie', query, language, config, page);
                break;
              case 'tmdb.search':
                metas = await performTmdbSearch(type, query, language, config, true, page);
                break;
              case 'tvdb.search':
                metas = await performTvdbSearch(type, query, language, config);
                break;
              case 'tvdb.collections.search':
                metas = await performTvdbCollectionsSearch(query, language, config);
                break;
              case 'tvmaze.search':
                metas = await performTvmazeSearch(query, language, config);
                break;
            }
          }
        }
        break;
      
      default:
        logger.warn(`Received unknown search ID: '${id}'`);
        break;
    }

    const searchDuration = Date.now() - searchStartTime;
    logger.info(`Search completed in ${searchDuration}ms for "${queryText}" (${id})`);
    
    // Record search timing metrics
    let actualProvider = getProviderFromSearchId(id);
    
    // For generic 'search' case, determine the actual provider used
    if (id === 'search' && extra.search) {
      let providerId;
      if (type === 'movie') {
        providerId = config.search?.providers?.movie;
      } else if (type === 'series') {
        providerId = config.search?.providers?.series;
      } else if (type === 'anime.movie') {
        providerId = config.search?.providers?.anime_movie;
      } else if (type === 'anime.series') {
        providerId = config.search?.providers?.anime_series;
      }
      
      if (providerId) {
        // Extract the actual provider name from the provider ID
        if (providerId.includes('mal.')) actualProvider = 'mal';
        else if (providerId.includes('kitsu.')) actualProvider = 'kitsu';
        else if (providerId.includes('tmdb.')) actualProvider = 'tmdb';
        else if (providerId.includes('tvdb.')) actualProvider = 'tvdb';
        else if (providerId.includes('tvmaze.')) actualProvider = 'tvmaze';
      }
    }
    
    timingMetrics.recordTiming('search_operation', searchDuration, {
      searchId: id,
      searchType: type,
      queryText: queryText,
      resultCount: metas.length,
      provider: actualProvider
    });
    
    // Also record provider-specific timing
    timingMetrics.recordTiming(`search_${actualProvider}`, searchDuration, {
      searchId: id,
      searchType: type,
      queryText: queryText,
      resultCount: metas.length
    });
    
    // Apply content exclusion filters if configured
    if (config.exclusionKeywords || config.regexExclusionFilter) {
      const beforeCount = metas.length;
      metas = filterMetasByRegex(metas, config.exclusionKeywords, config.regexExclusionFilter);
      const afterCount = metas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Content filter excluded ${beforeCount - afterCount} search results`);
      }
    }
    
    return { metas };
  } catch (error) {
    const searchDuration = Date.now() - searchStartTime;
    logger.error(`Search failed after ${searchDuration}ms for "${queryText}" (${id}):`, error);
    
    // Record failed search timing
    let actualProvider = getProviderFromSearchId(id);
    
    // For generic 'search' case, determine the actual provider used
    if (id === 'search' && extra.search) {
      let providerId;
      if (type === 'movie') {
        providerId = config.search?.providers?.movie;
      } else if (type === 'series') {
        providerId = config.search?.providers?.series;
      } else if (type === 'anime.movie') {
        providerId = config.search?.providers?.anime_movie;
      } else if (type === 'anime.series') {
        providerId = config.search?.providers?.anime_series;
      }
      
      if (providerId) {
        // Extract the actual provider name from the provider ID
        if (providerId.includes('mal.')) actualProvider = 'mal';
        else if (providerId.includes('kitsu.')) actualProvider = 'kitsu';
        else if (providerId.includes('tmdb.')) actualProvider = 'tmdb';
        else if (providerId.includes('tvdb.')) actualProvider = 'tvdb';
        else if (providerId.includes('tvmaze.')) actualProvider = 'tvmaze';
      }
    }
    
    timingMetrics.recordTiming('search_operation', searchDuration, {
      searchId: id,
      searchType: type,
      queryText: queryText,
      resultCount: 0,
      error: error.message,
      provider: actualProvider
    });
    
    // Also record provider-specific timing for failures
    timingMetrics.recordTiming(`search_${actualProvider}`, searchDuration, {
      searchId: id,
      searchType: type,
      queryText: queryText,
      resultCount: 0,
      error: error.message
    });
    
    return { metas: [] };
  }
}


module.exports = { getSearch };
