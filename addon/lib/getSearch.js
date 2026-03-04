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
const { cacheWrapMetaSmart } = require('./getCache');
const wikiMappings = require('./wiki-mapper.js');


const logger = consola.withTag('Search');
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

function isImdbId(query) {
  if (!query || typeof query !== 'string') return false;
  // IMDb ID format: tt followed by 7-8 digits
  const imdbIdPattern = /^tt\d{7,8}$/i;
  return imdbIdPattern.test(query.trim());
}

const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

const findArtwork = (artworks, type, lang, config) => {
  if (lang === null) {
    return artworks?.find(a => a.type === type && a.language === null)?.image
      || artworks?.find(a => a.type === type)?.image;
  }
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
  
  let tmdbId = extendedRecord.remoteIds?.find(id => id.sourceName === 'TheMovieDB.com')?.id;
  let imdbId = extendedRecord.remoteIds?.find(id => id.sourceName === 'IMDB')?.id;
  let tvmazeId = extendedRecord.remoteIds?.find(id => id.sourceName === 'TV Maze')?.id;
  let tvdbId = extendedRecord.id;
  let allIds = {
    tmdbId: tmdbId,
    imdbId: imdbId,
    tvmazeId: tvmazeId,
    tvdbId: tvdbId
  };
  allIds = await resolveAllIds(`tvdb:${tvdbId}`, type, config, allIds, ['imdb']);
  tmdbId = allIds.tmdbId;
  imdbId = allIds.imdbId;
  tvmazeId = allIds.tvmazeId;
  logger.debug('Resolved IDs:', {tmdbId, imdbId, tvmazeId, tvdbId});
  
  const rawPosterUrl = findArtwork(extendedRecord.artworks, type === 'movie' ? 14 : 2, langCode3, config);

  const fallbackImage = `${host}/missing_poster.png`;
  const posterUrl = rawPosterUrl || fallbackImage;
  
  const validPosterUrl = posterUrl && typeof posterUrl === 'string' && !posterUrl.includes('undefined') && posterUrl !== 'null' ? posterUrl : fallbackImage;
  // Top Poster API only supports IMDb and TMDB IDs, not TVDB
  // Use IMDb or TMDB ID if available when Top Poster API is selected
  let posterProxyId = `tvdb:${tvdbId}`;
  if (config.posterRatingProvider === 'top' && (imdbId || tmdbId)) {
    posterProxyId = imdbId || `tmdb:${tmdbId}`;
  }
  const posterProxyUrl = Utils.buildPosterProxyUrl(host, type, posterProxyId, validPosterUrl, language, config);
  
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
    poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : validPosterUrl,
    _rawPosterUrl: rawPosterUrl, 
    year: extendedRecord.year,
    description: Utils.addMetaProviderAttribution(overview, 'TVDB', config),
    certification: certification,
    logo: validLogoUrl,
    runtime: type === 'movie' ? Utils.parseRunTime(extendedRecord.runtime) : Utils.parseRunTime(extendedRecord.averageRuntime),
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
    const desiredTvTypes = config.mal?.useImdbIdForCatalogAndSearch ?  new Set(['tv', 'ona']) : new Set(['tv', 'ova', 'ona', 'tv special']);
    const normalizedTvSubtypes = [...new Set(Array.from(desiredTvTypes).map((subtype) => {
      // Kitsu uses "special" as subtype; normalize our legacy "tv special" value.
      return subtype.toLowerCase() === 'tv special' ? 'special' : subtype;
    }))];
    const subtypesArray = type === 'movie' ? ['movie'] : [normalizedTvSubtypes.join(',')];
    const searchResults = await kitsu.searchByName(
      query,
      subtypesArray,
      'none'
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
          const malId = mapping?.mal_id;
          let tmdbId = type === 'movie' ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals.tmdb : mapping?.themoviedb_id;
          let imdbId = type === 'movie' ? idMapper.getTraktAnimeMovieByMalId(malId)?.externals.imdb : mapping?.imdb_id;
          let tvdbId = type === 'movie' ? (wikiMappings.getByImdbId(imdbId, type))?.tvdbId || null : mapping?.tvdb_id;

          const imdbRating = imdbId ? await getImdbRating(imdbId, type) : 'N/A';
          let id = imdbId || `kitsu:${kitsuId}`;
          const preferredProvider = config.providers?.anime || 'mal';
          if(preferredProvider === 'kitsu') {
            id = `kitsu:${kitsuId}`;
          } else if(preferredProvider === 'mal') {
            id = `mal:${mapping?.mal_id}`;
          } 
          if((config.mal?.useImdbIdForCatalogAndSearch && type === 'series')){
            return (await cacheWrapMetaSmart(config.userUUID, id, async () => {
              const { getMeta } = await import("../lib/getMeta");
              return await getMeta(type, language, `kitsu:${kitsuId}`, config, config.userUUID, false);
            }, undefined, {enableErrorCaching: true, maxRetries: 2}, type, false))?.meta || null;
          }
          
          
          const background = mapping?.mal_id ? await Utils.getAnimeBg({malId: mapping?.mal_id, imdbId: imdbId, tvdbId: tvdbId, tmdbId: tmdbId, mediaType: type === 'movie' ? 'movie' : 'series', malPosterUrl: item.coverImage?.original}, config) : item.coverImage?.original;
          const poster = mapping?.mal_id ? await Utils.getAnimePoster({malId: mapping?.mal_id, imdbId: imdbId, tvdbId: tvdbId, tmdbId: tmdbId, mediaType: type === 'movie' ? 'movie' : 'series', malPosterUrl: item.posterImage?.original}, config) : item.posterImage?.original;
          const logo = type === 'movie' ? tmdbId ? await moviedb.getTmdbMovieLogo(tmdbId, config) : null : await Utils.getAnimeLogo({malId: mapping?.mal_id, imdbId: imdbId, tvdbId: tvdbId, tmdbId: tmdbId, mediaType: type === 'movie' ? 'movie' : 'series'}, config);
          
          // Apply RPDB for series (non-movies)
          let finalPoster = poster || `${host}/missing_poster.png`;
          if (Utils.isPosterRatingEnabled(config)) {
            let proxyId = null;
            if (imdbId) {
              proxyId = imdbId;
            } else if (tvdbId) {
              proxyId = `tvdb:${tvdbId}`;
            } else if (tmdbId) {
              proxyId = `tmdb:${tmdbId}`;
            }
            if (proxyId) {
              finalPoster = Utils.buildPosterProxyUrl(host, 'series', proxyId, finalPoster, language, config);
            }
          }
          
          return {
            id: `kitsu:${kitsuId}`,
            type: type === 'movie' ? 'movie' : 'series',
            name: Utils.getKitsuLocalizedTitle(item.titles, language) || item.canonicalTitle, 
            poster: finalPoster,
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
    
    let finalMetas = metas.filter(Boolean);

    if (config.ageRating && config.ageRating.toLowerCase() !== 'none') {
      const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
      const kitsuMap = { 'G': 'G', 'PG': 'PG', 'PG-13': 'PG-13', 'R': 'R', 'R18': 'NC-17' };
      
      finalMetas = finalMetas.filter(result => {
        const cert = result.certification;
        if (!cert) return true;
        
        const mappedCert = kitsuMap[cert] || cert;
        const userRating = config.ageRating === 'R18' ? 'NC-17' : config.ageRating;
        
        const userRatingIndex = movieRatingHierarchy.indexOf(userRating);
        const resultRatingIndex = movieRatingHierarchy.indexOf(mappedCert);
        
        if (userRatingIndex === -1) return true;
        if (resultRatingIndex === -1) return true;
        
        return resultRatingIndex <= userRatingIndex;
      });
    }

    return finalMetas;
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

async function performTmdbSearch(type, query, language, config, searchPersons = true, page = 1, peopleOnly = false) {
  const startTime = Date.now();
  const rawResults = new Map();
  logger.info(`Starting TMDB search for type "${type}" with query: "${query}"`);

  // Check if query is an IMDb ID
  if (isImdbId(query) && !peopleOnly) {
    logger.info(`Detected IMDb ID: ${query}, using TMDB find API`);
    try {
      const findResult = await moviedb.find({ id: query.trim(), external_source: 'imdb_id' }, config);
      const results = type === 'movie' ? findResult.movie_results : findResult.tv_results;
      
      if (results && results.length > 0) {
        const media = results[0];
        media.media_type = type === 'movie' ? 'movie' : 'tv';
        rawResults.set(media.id, media);
        logger.info(`Found ${type} via IMDb ID ${query}: ${media.title || media.name}`);
      } else {
        logger.info(`No ${type} found for IMDb ID ${query}`);
        return [];
      }
    } catch (error) {
      logger.error(`Error searching TMDB by IMDb ID ${query}:`, error.message);
      return [];
    }
  } else {
    // STEP 1: GATHER ALL POTENTIAL IDs IN PARALLEL (from title search and person search)
  const addRawResult = (media) => {
      if (media && media.id && !rawResults.has(media.id)) {
          media.media_type = type === 'movie' ? 'movie' : 'tv';
          rawResults.set(media.id, media);
      }
  };

  const shouldSearchPersons = (() => {
    if (!searchPersons) return false; // Respect the explicit parameter
    
    // Skip if contains invalid symbols or standalone numbers/years
    // Symbols: : ( ) [ ] ? ! $ # @ &
    // Numbers: "3", "1999" (matches) but NOT "3rd", "1st" (doesn't match)
    const invalidNamePattern = /[:()[\]?!$#@&]|\b\d+\b/;
    if (invalidNamePattern.test(query)) {
      logger.debug(`Skipping person search due to invalid characters or numbers: "${query}"`);
      return false;
    }
    
    // If checks pass, it's plausible the user is searching for a person.
    return true;
  })();

  // Run the initial title search and person search concurrently
  // Skip title search if peopleOnly is true
  const [titleRes, personCredits] = await Promise.all([
      peopleOnly 
          ? Promise.resolve({ results: [] })
          : (type === 'movie'
              ? moviedb.searchMovie({ query, language, include_adult: config.includeAdult, page }, config)
              : moviedb.searchTv({ query, language, include_adult: config.includeAdult, page }, config)),
      
      shouldSearchPersons
          ? moviedb.searchPerson({ query, language: language }, config).then(async personRes => {
              if (personRes.results?.length > 0) {
                const sortedPersons = personRes.results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
                const topPerson = sortedPersons[0];
                
                logger.debug(`Person found: ${topPerson.name} (popularity: ${topPerson.popularity || 0})`);
                
                // Thresholds for person validation
                const MIN_QUALITY_WORK_VOTES = 4000;
                const MIN_RECOGNIZED_WORK_VOTES = 100;
                const MIN_POPULARITY_WITH_QUALITY_WORK = 1.5;
                const MIN_POPULARITY_PRIMARY_NAME = 2.5;
                
                // Check work recognition
                const knownFor = topPerson.known_for || [];
                const highestVoteCount = Math.max(0, ...knownFor.map(work => work.vote_count || 0));
                logger.debug(`Person ${topPerson.name} highest vote count in known_for: ${highestVoteCount}`);
                
                // Early exit: skip if person has very low popularity or no profile picture
                const personPopularity = topPerson.popularity || 0;
                if (personPopularity < MIN_POPULARITY_WITH_QUALITY_WORK || !topPerson.profile_path) {
                  logger.debug(`Skipping person ${topPerson.name} - too low popularity or missing profile picture`);
                  return [];
                }
                
                // Early exit: person must have at least one recognized work
                if (highestVoteCount < MIN_RECOGNIZED_WORK_VOTES) {
                  logger.debug(`Skipping person ${topPerson.name} - no recognized work (highest vote count: ${highestVoteCount})`);
                  return [];
                }
                
                // Normalize names for strict matching
                // Handles: diacritics, periods (initials), hyphens
                const normalizeNameForMatching = (name) => {
                  return name
                    .toLowerCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics (Penélope → Penelope)
                    .replace(/\./g, '') // Remove periods (Samuel L. → Samuel L)
                    .replace(/-/g, ' ') // Hyphens to spaces (Jean-Claude → Jean Claude)
                    .replace(/\s+/g, ' ') // Multiple spaces to single
                    .trim();
                };
                
                const queryNorm = normalizeNameForMatching(query);
                const personNameNorm = normalizeNameForMatching(topPerson.name);
                
                // Early exit: skip if normalization resulted in empty strings
                if (!queryNorm || !personNameNorm) {
                  logger.debug(`Skipping person ${topPerson.name} - empty string after normalization`);
                  return [];
                }
                
                // Split into words for analysis
                const queryWords = queryNorm.split(' ').filter(w => w); // Filter empty strings
                const personWords = personNameNorm.split(' ').filter(w => w);
                
                // Check work quality (needed for single-word validation)
                const hasHighQualityWork = highestVoteCount >= MIN_QUALITY_WORK_VOTES;
                
                // Match type 1: Exact match
                const isExactMatch = queryNorm === personNameNorm;
                
                // Match type 2: Middle initial tolerance
                // User searches "Samuel Jackson", API returns "Samuel L Jackson"
                // Only matches if the middle word is a single letter (initial)
                const isMiddleNameMatch = personWords.length === 3 && queryWords.length === 2 &&
                  queryWords[0] === personWords[0] && 
                  queryWords[1] === personWords[2] &&
                  personWords[1].length === 1; // Middle word must be single-letter initial
                
                // Match type 3: Suffix tolerance
                // User searches "Robert Downey", API returns "Robert Downey Jr"
                // Only matches if API name ends with a suffix (Jr, Sr, II, III, IV, V)
                const suffixPattern = /^(jr|sr|ii|iii|iv|v)$/i;
                const isSuffixMatch = personWords.length >= 3 && 
                  queryWords.length === personWords.length - 1 &&
                  suffixPattern.test(personWords[personWords.length - 1]) &&
                  queryWords.every((word, index) => word === personWords[index]);
                
                // Match type 4: Single word match (requires quality check)
                // User searches "Lucy", API returns "Lucy" - must have high quality work
                const isSingleWordMatch = queryWords.length === 1 && personWords.length === 1 &&
                  queryWords[0] === personWords[0] &&
                  hasHighQualityWork && personPopularity >= MIN_POPULARITY_WITH_QUALITY_WORK;
                
                const primaryNameMatches = isExactMatch || isMiddleNameMatch || isSuffixMatch || isSingleWordMatch;
                
                // Name must match
                if (!primaryNameMatches) {
                  logger.debug(`Skipping person ${topPerson.name} - query "${query}" doesn't match name`);
                  return [];
                }
                
                // Check if person meets quality/popularity requirements
                const passesQualityCheck = hasHighQualityWork && personPopularity >= MIN_POPULARITY_WITH_QUALITY_WORK;
                const passesPopularityCheck = personPopularity >= MIN_POPULARITY_PRIMARY_NAME;
                
                if (passesQualityCheck || passesPopularityCheck) {
                  logger.debug(`Person match confirmed: ${topPerson.name} (popularity: ${personPopularity})`);
                } else {
                  logger.debug(`Skipping person ${topPerson.name} - insufficient popularity (${personPopularity})`);
                  return [];
                }
                
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
  }
  
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
        backgroundUrl = selectedBg?.file_path ? `https://image.tmdb.org/t/p/original${selectedBg?.file_path}` : details.backdrop_path ? `https://image.tmdb.org/t/p/original${details.backdrop_path}` : null;
        posterUrl = selectedPoster?.file_path ? `https://image.tmdb.org/t/p/original${selectedPoster?.file_path}` : details.poster_path ? `https://image.tmdb.org/t/p/original${details.poster_path}` : fallbackImage;

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
        
        const posterProxyUrl = Utils.buildPosterProxyUrl(host, mediaType, `tmdb:${media.id}`, validPosterUrl, language, config);
        
        let stremioId = `tmdb:${media.id}`; // Default to TMDB
        if(allIds?.imdbId) stremioId = allIds.imdbId;
        
        // Assemble the final meta object
        const parsed = Utils.parseMedia(details, mediaType, [], config);
        if (!parsed) return null; // In case parsing fails
        parsed.id = stremioId;
        parsed.poster = Utils.isPosterRatingEnabled(config) ? posterProxyUrl : validPosterUrl;
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
    const adultKeywordBlacklist = ['porn', 'porno', 'soft porn', 'softcore', 'pinku-eiga','erotica', 'erotic film', 'erotic movie', 'adult video'];
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
  if (type === 'movie' && config.hideUnreleasedDigitalSearch) {
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

async function performTmdbPeopleSearch(type, query, language, config, page = 1) {
  const startTime = Date.now();
  logger.info(`[People Search] Starting lightweight people search for type "${type}" with query: "${query}"`);

  // Skip if query looks like a title, not a person name
  const invalidNamePattern = /[:()[\]?!$#@&]|\b\d+\b/;
  if (invalidNamePattern.test(query)) {
    logger.debug(`[People Search] Skipping - query contains invalid characters for a person name: "${query}"`);
    return [];
  }

  try {
    // Step 1: Search for person (1 API call)
    const personRes = await moviedb.searchPerson({ query, language: language }, config);

    if (!personRes.results?.length) {
      logger.info(`[People Search] No person found for query: "${query}"`);
      return [];
    }

    const sortedPersons = personRes.results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    const normalizeNameForMatching = (name) => {
      return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\./g, '')
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    };
    // Check up to top 5 results for a name match instead of only the first
    const MAX_PERSON_CANDIDATES = 5;
    const MIN_QUALITY_WORK_VOTES = 4000;
    const MIN_RECOGNIZED_WORK_VOTES = 100;
    const MIN_POPULARITY_WITH_QUALITY_WORK = 1.5;
    const MIN_POPULARITY_PRIMARY_NAME = 2.5;
    const candidates = sortedPersons.slice(0, MAX_PERSON_CANDIDATES);
    let allCredits = [];
    const suffixPattern = /^(jr|sr|ii|iii|iv|v)$/i;
    for (const candidate of candidates) {
      const personPopularity = candidate.popularity || 0;
      const knownFor = candidate.known_for || [];
      const highestVoteCount = Math.max(...knownFor.map((w) => w.vote_count || 0), 0);
    
      if (personPopularity < MIN_POPULARITY_WITH_QUALITY_WORK && highestVoteCount < MIN_RECOGNIZED_WORK_VOTES) {
        logger.debug(`Skipping person ${candidate.name} - low popularity (${personPopularity}) and no recognized work (${highestVoteCount} votes)`);
        continue;
      }
      
      const personNameNorm = normalizeNameForMatching(candidate.name);
      const queryNorm = normalizeNameForMatching(query);
      if (!personNameNorm) continue;
      const personWords = personNameNorm.split(' ').filter(w => w);
      const queryWords = queryNorm.split(' ').filter(w => w);
      const hasHighQualityWork = highestVoteCount >= MIN_QUALITY_WORK_VOTES;

      if (!queryNorm || !personNameNorm) {
        return [];
      }
      
      const isExactMatch = queryNorm === personNameNorm;
      const isMiddleNameMatch = personWords.length === 3 && queryWords.length === 2 &&
        queryWords[0] === personWords[0] &&
        queryWords[1] === personWords[2] &&
        personWords[1].length === 1;
      const isSuffixMatch = personWords.length >= 3 &&
        queryWords.length === personWords.length - 1 &&
        suffixPattern.test(personWords[personWords.length - 1]) &&
        queryWords.every((word, index) => word === personWords[index]);
      const isSingleWordMatch = queryWords.length === 1 && personWords.length === 1 &&
        queryWords[0] === personWords[0] &&
        hasHighQualityWork && personPopularity >= MIN_POPULARITY_WITH_QUALITY_WORK;
      
      const primaryNameMatches = isExactMatch || isMiddleNameMatch || isSuffixMatch || isSingleWordMatch;
      if (!primaryNameMatches) {
        logger.debug(`Skipping person ${candidate.name} - query "${query}" doesn't match name`);
        continue;
      }
      
      logger.debug(`Person match confirmed: ${candidate.name} (popularity: ${personPopularity})`);
      const credits = type === 'movie'
        ? await moviedb.personMovieCredits({ id: candidate.id, language }, config)
        : await moviedb.personTvCredits({ id: candidate.id, language }, config);
      allCredits= [...(credits.cast || []), ...(credits.crew || [])];
      break;
    }

    if (allCredits.length === 0) {
      return [];
    }

    // Deduplicate by TMDB ID
    const seen = new Map();
    for (const credit of allCredits) {
      if (credit && credit.id && !seen.has(credit.id)) {
        credit.media_type = type === 'movie' ? 'movie' : 'tv';
        credit.matchType = 'person';
        seen.set(credit.id, credit);
      }
    }

    // Sort and paginate
    const sorted = Utils.sortSearchResults(Array.from(seen.values()), query);
    const pageSize = 25;
    const startIndex = (page - 1) * pageSize;
    let pageResults = sorted.slice(startIndex, startIndex + pageSize);

    if (type === 'series') {
      const excludedGenreIds = new Set([10767, 10763]); // Talk, News
      const beforeCount = pageResults.length;
      pageResults = pageResults.filter(media => {
        if (!media.genre_ids || media.genre_ids.length === 0) return true;
        // Exclude if the ONLY genres are talk/news
        const nonExcluded = media.genre_ids.filter(id => !excludedGenreIds.has(id));
        return nonExcluded.length > 0;
      });
      if (beforeCount !== pageResults.length) {
        logger.debug(`[People Search] Filtered ${beforeCount - pageResults.length} talk/news shows`);
      }
    }

    if (config.includeAdult === false) {
      const beforeAdult = pageResults.length;
      pageResults = pageResults.filter(media => !media.adult);
      if (beforeAdult !== pageResults.length) {
        logger.debug(`[People Search] Filtered ${beforeAdult - pageResults.length} adult results`);
      }
    }

    // Build lightweight metas directly from credit data — NO hydration API calls
    const fallbackImage = `${host}/missing_poster.png`;
    const metas = (await Promise.all(
      pageResults
      .map(async media => {
        const mediaType = media.media_type === 'movie' ? 'movie' : 'series';
        if (mediaType !== type) return null;

        const title = type === 'movie' ? media.title : media.name;
        if (!title) return null;

        const posterPath = media.poster_path
          ? `https://image.tmdb.org/t/p/original${media.poster_path}`
          : fallbackImage;
        const backgroundPath = media.backdrop_path
          ? `https://image.tmdb.org/t/p/original${media.backdrop_path}`
          : null;

        let stremioId = `tmdb:${media.id}`;
        const allIds = await resolveAllIds(`tmdb:${media.id}`, mediaType, config, {}, ['imdb']);
        if(allIds?.imdbId) stremioId = allIds.imdbId

        const posterProxyUrl = Utils.buildPosterProxyUrl(
          host, mediaType, stremioId, posterPath, language, config
        );

        return {
          id: stremioId,
          type: mediaType,
          name: title,
          poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : posterPath,
          background: backgroundPath,
          posterShape: 'regular',
          imdbRating: allIds?.imdbId ? await getImdbRating(allIds.imdbId, mediaType) : null,
          year: type === 'movie'
            ? (media.release_date?.substring(0, 4) || '')
            : (media.first_air_date?.substring(0, 4) || ''),
          released: type === 'movie' ? new Date(media.release_date) : new Date(media.first_air_date),
          description: media.overview
            ? Utils.addMetaProviderAttribution(media.overview, 'TMDB', config)
            : (media.character ? `As: ${media.character}` : ''),
          popularity: media.popularity,
          vote_average: media.vote_average || 0,
          vote_count: media.vote_count || 0,
        };
      })
    )).filter(Boolean);

    // Apply age rating filter if configured
    // (skip — person credits don't have certification data, would need hydration)

    logger.success(`[People Search] Completed in ${Date.now() - startTime}ms. Returning ${metas.length} ${type} results (${allCredits.length} total credits).`);
    return metas;

  } catch (error) {
    logger.error(`[People Search] Error: ${error.message}`);
    return [];
  }
}


/**
 * Combined TMDB matching and enrichment for AI search suggestions.
 * Performs search, validation, and full metadata enrichment in a single operation.
 * This eliminates the async barrier between separate match and enrich phases.
 * 
 * @param {Object} suggestion - The AI suggestion with title, year, and type.
 * @param {string} language - The language code.
 * @param {Object} config - The user configuration.
 * @returns {Promise<Object|null>} The enriched metadata or null if no match found.
 */
async function matchAndEnrichFromTMDB(suggestion, language, config) {
  const { title, year, type } = suggestion;
  
  try {
    // Step 1: Search TMDB for the title
    const searchParams = {
      query: title,
      language: 'en-US', 
      include_adult: config.includeAdult || false,
      page: 1
    };
    
    const searchResults = type === 'movie'
      ? await moviedb.searchMovie(searchParams, config)
      : await moviedb.searchTv(searchParams, config);
    
    if (!searchResults?.results || searchResults.results.length === 0) {
      logger.debug(`No TMDB match found for "${title}" (${year})`);
      return null;
    }
    
    // Step 2: Find the best match from results
    const normalizeTitle = (t) => t
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    const normalizedSearchTitle = normalizeTitle(title);
    
    let match = null;
    for (const result of searchResults.results) {
      const resultTitle = type === 'movie' ? result.title : result.name;
      const resultOriginalTitle = type === 'movie' ? result.original_title : result.original_name;
      const resultYear = type === 'movie' 
        ? result.release_date?.substring(0, 4)
        : result.first_air_date?.substring(0, 4);
      
      // Check both localized title and original title for matches
      const titleMatch = normalizeTitle(resultTitle) === normalizedSearchTitle ||
        (resultOriginalTitle && normalizeTitle(resultOriginalTitle) === normalizedSearchTitle);
      const yearMatch = resultYear && Math.abs(parseInt(resultYear) - parseInt(year)) <= 1;
      
      if (titleMatch && yearMatch) {
        match = result;
        logger.debug(`Matched "${title}" (${year}) -> "${resultTitle}" (${resultYear}) TMDB ID: ${result.id}`);
        break;
      }
    }
    
    if (!match) {
      logger.debug(`Failed to match "${title}" (${year}) - no matching results in TMDB`);
      return null;
    }
    
    // Step 3: Immediately enrich the matched result (no separate phase)
    const tmdbId = match.id;
    const langCode = language.split('-')[0];
    const imageLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
    
    const details = type === 'movie'
      ? await moviedb.movieInfo({ 
          id: tmdbId, 
          language, 
          append_to_response: "external_ids,release_dates,images,keywords",
          include_image_language: imageLanguages 
        }, config)
      : await moviedb.tvInfo({ 
          id: tmdbId, 
          language, 
          append_to_response: "external_ids,content_ratings,images,keywords",
          include_image_language: imageLanguages 
        }, config);
    
    // --- Safety Filter: Keyword Blacklist ---
    if (config.includeAdult === false) {
      const adultKeywordBlacklist = ['porn', 'porno', 'soft porn', 'softcore', 'pinku-eiga'];
      const keywordsObject = details.keywords;
      
      if (keywordsObject) {
        // Keywords can be in `results` (TV) or `keywords` (Movie)
        const keywords = keywordsObject.results || keywordsObject.keywords || [];
        
        for (const keyword of keywords) {
          if (adultKeywordBlacklist.includes(keyword.name.toLowerCase())) {
            logger.debug(`Item "${title}" filtered because of blacklist keyword "${keyword.name}"`);
            return null;
          }
        }
      }
    }
    
    // Resolve IDs
    let allIds = {
      tmdbId: details.id,
      imdbId: details.external_ids?.imdb_id || details.imdb_id,
      tvdbId: details.external_ids?.tvdb_id
    };
    allIds = await resolveAllIds(`tmdb:${tmdbId}`, type, config, allIds, ['imdb']);
    
    // Select images
    const selectedBg = details.images?.backdrops?.find(b => b.iso_639_1 === 'xx')
      || details.images?.backdrops?.find(b => b.iso_639_1 === null)
      || details.images?.backdrops?.find(b => b.iso_639_1 === langCode)
      || details.images?.backdrops?.[0];
    const selectedLogo = Utils.selectTmdbImageByLang(details.images?.logos, config);
    const selectedPoster = Utils.selectTmdbImageByLang(details.images?.posters, config);
    
    const fallbackImage = `${host}/missing_poster.png`;
    const logoUrl = selectedLogo?.file_path ? `https://image.tmdb.org/t/p/original${selectedLogo.file_path}` : null;
    const backgroundUrl = selectedBg?.file_path ? `https://image.tmdb.org/t/p/original${selectedBg.file_path}` 
      : details.backdrop_path ? `https://image.tmdb.org/t/p/original${details.backdrop_path}` : null;
    const posterUrl = selectedPoster?.file_path ? `https://image.tmdb.org/t/p/original${selectedPoster.file_path}` 
      : details.poster_path ? `https://image.tmdb.org/t/p/original${details.poster_path}` : fallbackImage;
    
    const validPosterUrl = posterUrl && posterUrl !== 'null' && !posterUrl.includes('undefined') 
      ? posterUrl : fallbackImage;
    
    const posterProxyUrl = Utils.buildPosterProxyUrl(host, type, `tmdb:${tmdbId}`, validPosterUrl, language, config);
    
    // Get IMDB rating
    const imdbRating = allIds.imdbId ? await getImdbRating(allIds.imdbId, type) : null;
    
    // Determine Stremio ID
    let stremioId = `tmdb:${tmdbId}`;
    if (allIds?.imdbId) stremioId = allIds.imdbId;
    
    // Parse media
    const parsed = Utils.parseMedia(details, type, [], config);
    if (!parsed) return null;
    
    // Assemble final meta
    parsed.id = stremioId;
    parsed.poster = Utils.isPosterRatingEnabled(config) ? posterProxyUrl : validPosterUrl;
    parsed.imdbRating = imdbRating;
    parsed.logo = logoUrl;
    parsed.background = backgroundUrl;
//    parsed.popularity = match.popularity;
//    parsed.score = match.vote_average;
    parsed.certification = type === 'movie'
      ? Utils.getTmdbMovieCertificationForCountry(details.release_dates)
      : Utils.getTmdbTvCertificationForCountry(details.content_ratings);
    if (allIds.imdbId) parsed.imdb_id = allIds.imdbId;
    parsed.runtime = type === 'movie' ? Utils.parseRunTime(details.runtime) : null;
    if (type === 'series') {
      parsed.runtime = Utils.parseRunTime(
        details.episode_run_time?.[0] ?? 
        details.last_episode_to_air?.runtime ?? 
        details.next_episode_to_air?.runtime ?? 
        null
      );
    }

    parsed.app_extras = { releaseDates: details.release_dates };

    return parsed;
    
  } catch (error) {
    logger.error(`Failed to match/enrich "${title}" (${year}):`, error.message);
    return null;
  }
}


/**
 * Performs AI-powered search with mixed movie/series results.
 * Single Gemini call returns both types, then matches and enriches all in parallel.
 * 
 * @param {string} query - The user's natural language search query.
 * @param {string} language - The language code.
 * @param {Object} config - The user configuration.
 * @returns {Promise<Array>} Array of enriched and filtered metadata.
 */
async function performAiSearch(query, language, config) {
  const startTime = Date.now();
  logger.info(`Starting AI search for query: "${query}"`);
  
  try {
    // Phase 1: AI Generation and Parsing
    const geminiKey = config.apiKeys?.gemini;
    const suggestions = await performGeminiSearch(geminiKey, query, 'mixed', language);
    
    if (!suggestions || suggestions.length === 0) {
      logger.info('Gemini returned no suggestions.');
      return [];
    }
    
    logger.debug(`Gemini returned ${suggestions.length} suggestions`);
    
    // Phase 2: Combined TMDB matching + enrichment (single parallel operation)
    // This eliminates the async barrier between separate match and enrich phases
    logger.info(`Starting combined TMDB match+enrich for ${suggestions.length} suggestions`);
    const enrichStart = Date.now();
    
    const enrichPromises = suggestions.map(suggestion =>
      matchAndEnrichFromTMDB(suggestion, language, config)
    );
    
    const enrichedResults = await Promise.all(enrichPromises);
    const enrichTime = Date.now() - enrichStart;
    
    // Filter out null results (failed matches or enrichments)
    const validResults = enrichedResults.filter(Boolean);
    logger.info(`TMDB match+enrich completed in ${enrichTime}ms. Got ${validResults.length} of ${suggestions.length} suggestions`);
    
    // Phase 4: Apply content filters
    let filteredResults = validResults;
    
    // Apply age rating filter (works for both movies and series)
    if (config.ageRating && config.ageRating.toLowerCase() !== 'none') {
      const beforeCount = filteredResults.length;
      const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
      const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
      const movieToTvMap = { 'G': 'TV-G', 'PG': 'TV-PG', 'PG-13': 'TV-14', 'R': 'TV-MA', 'NC-17': 'TV-MA' };

      filteredResults = filteredResults.filter(result => {
        const cert = result.certification;
        const isTvRating = result.type === 'series';
        const userRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
        const isUserRatingRestrictive = userRating === 'PG-13' || 
                                       (movieRatingHierarchy.indexOf(userRating) !== -1 && 
                                        movieRatingHierarchy.indexOf(userRating) <= movieRatingHierarchy.indexOf('PG-13')) ||
                                       (tvRatingHierarchy.indexOf(userRating) !== -1 && 
                                        tvRatingHierarchy.indexOf(userRating) <= tvRatingHierarchy.indexOf('TV-14'));
        
        if (!cert || cert === "" || cert.toLowerCase() === 'nr') {
          return !isUserRatingRestrictive;
        }
        
        const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
        const userRatingIndex = ratingHierarchy.indexOf(userRating);
        const resultRatingIndex = ratingHierarchy.indexOf(cert);
        
        if (userRatingIndex === -1) return true;
        if (resultRatingIndex === -1) return true;
        
        return resultRatingIndex <= userRatingIndex;
      });
      
      const afterCount = filteredResults.length;
      if (beforeCount !== afterCount) {
        logger.info(`Age rating filter: ${beforeCount} -> ${afterCount} results`);
      }
    }
    
    // Apply digital release filter for movies only
    if (config.hideUnreleasedDigitalSearch) {
      const beforeCount = filteredResults.length;
      filteredResults = filteredResults.filter(meta => 
        meta.type !== 'movie' || Utils.isReleasedDigitally(meta)
      );
      const afterCount = filteredResults.length;
      if (beforeCount !== afterCount) {
        logger.info(`Digital release filter: filtered out ${beforeCount - afterCount} unreleased movies`);
      }
    }
    
    // Apply exclusion keyword and regex filters
    if (config.exclusionKeywords || config.regexExclusionFilter) {
      const beforeCount = filteredResults.length;
      filteredResults = filterMetasByRegex(filteredResults, config.exclusionKeywords, config.regexExclusionFilter);
      const afterCount = filteredResults.length;
      if (beforeCount !== afterCount) {
        logger.info(`Content exclusion filter: ${beforeCount} -> ${afterCount} results`);
      }
    }
    
    const totalTime = Date.now() - startTime;
    logger.success(`AI search completed in ${totalTime}ms. Returning ${filteredResults.length} results.`);
    
    return filteredResults;
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    logger.error(`AI search failed after ${totalTime}ms:`, error.message);
    return [];
  }
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

          if (!details || !Array.isArray(details.entities)) return null;

          // Only include collections that have at least one movie
          const hasMovies = details.entities.some(e => e.movieId);
          if (!hasMovies) return null;

          const translatedName = translations?.name || details.name;
          const translatedOverview = translations?.overview || details.overview;

          return {
            id: `tvdbc:${collectionId}`,
            type: 'movie', // Collections are movies only
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
  // Check if query is an IMDb ID
  if (isImdbId(query)) {
    logger.info(`Detected IMDb ID: ${query}, using TVDB findByImdbId`);
    try {
      const imdbId = query.trim();
      const results = await tvdb.findByImdbId(imdbId, config);
      
      if (!results || results.length === 0) {
        logger.info(`No TVDB results found for IMDb ID ${imdbId}`);
        return [];
      }
      
      // TVDB findByImdbId returns results with either movie or series property
      const tvdbId = type === 'movie' 
        ? results[0]?.movie?.id 
        : results[0]?.series?.id;
      
      if (!tvdbId) {
        logger.info(`No ${type} found in TVDB for IMDb ID ${imdbId}`);
        return [];
      }
      
      // Fetch extended details
      const extendedRecord = type === 'movie' 
        ? await tvdb.getMovieExtended(tvdbId, config)
        : await tvdb.getSeriesExtended(tvdbId, config);
      
      if (!extendedRecord) {
        logger.warn(`Could not fetch extended details for TVDB ID ${tvdbId}`);
        return [];
      }
      
      // Parse and return the result
      const parsed = await parseTvdbSearchResult(type, extendedRecord, language, config);
      return parsed ? [parsed] : [];
    } catch (error) {
      logger.error(`Error searching TVDB by IMDb ID ${query}:`, error.message);
      return [];
    }
  }
  
  const sanitizedQuery = sanitizeQuery(query);
  if (!sanitizedQuery) return [];

  const idMap = new Map(); 

  // STEP 1: GATHER IDs FROM TITLE SEARCH
  const searchStartTime = Date.now();
  logger.info(`Starting TVDB title search for: "${sanitizedQuery}"`);

  // Title search only - no person search
  const titleResults = await (type === 'movie' 
    ? tvdb.searchMovies(sanitizedQuery, config) 
    : tvdb.searchSeries(sanitizedQuery, config));

  logger.debug(`TVDB initial search completed in ${Date.now() - searchStartTime}ms.`);

  (titleResults || []).forEach(result => {
    const resultId = result.tvdb_id || result.id;
    if (resultId) {
      idMap.set(String(resultId), type);
    }
  });
  
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

/**
 * Perform TVDB people-only search for movies or series
 */
async function performTvdbPeopleSearch(type, query, language, config) {
  const searchStartTime = Date.now();
  logger.info(`Starting TVDB people-only search for type "${type}" with query: "${query}"`);

  const sanitizedQuery = sanitizeQuery(query);
  if (!sanitizedQuery) return [];

  const idMap = new Map();

  // Determine if we should search for persons
  const shouldSearchPersons = (() => {
    // Check for symbols that are unlikely in a person's name
    const nameInvalidatingSymbols = /[:()[\]?!$#@&]/;
    if (nameInvalidatingSymbols.test(query)) {
      logger.debug(`Skipping person search due to invalid symbols in query: "${query}"`);
      return false;
    }
    return true;
  })();

  if (!shouldSearchPersons) {
    logger.info(`No TVDB people search results found for query: "${query}"`);
    return [];
  }

  // People search only - no title search
  const peopleResults = await tvdb.searchPeople(sanitizedQuery, config);

  logger.debug(`TVDB people search completed in ${Date.now() - searchStartTime}ms.`);

  // Process people results to find related movies/series
  if (peopleResults && peopleResults.length > 0) {
    const topPerson = peopleResults[0];
    try {
      const personDetails = await tvdb.getPersonExtended(topPerson.tvdb_id, config);
      if (personDetails && personDetails.characters) {
        personDetails.characters
          .filter(credit => credit.type === 3 || credit.type === 1 || credit.type === 2) // Filter for 'Actor' 'Director' 'Writer' role type
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
    logger.info('No unique TVDB IDs found after people search.');
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
  const parsePromises = detailedResults.map(record =>
    parseTvdbSearchResult(type, record, language, config)
  );
    
  const finalResults = (await Promise.all(parsePromises)).filter(Boolean);
  logger.info(`Successfully parsed ${finalResults.length} items into Stremio metas.`);


  const processedResults = finalResults.map((item) => {
    const year = item.status === 'Upcoming' ? 9999 : (parseInt(item.year, 10) || 0);
    const hasRealPoster = !!item._rawPosterUrl;
    const hasOverview = !!(item.description && item.description.trim() !== '');
    
    return {
      originalItem: item,
      year,
      hasPoster: hasRealPoster,
      hasOverview: hasOverview,
      isContinuing: item.status === "Continuing",
      isUpcoming: item.status === "Upcoming",
    };
  });
  
  let filteredResults = processedResults.filter(item => {
    // Filter out items without a year (unless upcoming)
    if (!item.year && !item.isUpcoming) {
      return false;
    }
    // Only remove if it's missing BOTH a poster AND an overview
    const isLowQuality = !item.hasPoster && !item.hasOverview;
    if (isLowQuality) {
      return false;
    }
    return true;
  });
  
  // Safety net: If filtering removed everything, fall back to original results
  if (filteredResults.length === 0 && processedResults.length > 0) {
    logger.warn("⚠️ People search filtering removed all results. Falling back to original order.");
    filteredResults = processedResults;
  }
  
  // 3. SORT: prioritize items with posters, de-prioritize upcoming, then sort by year (newest first)
  filteredResults.sort((a, b) => {
    // Primary: Items WITH a poster over those without
    if (a.hasPoster !== b.hasPoster) {
      return a.hasPoster ? -1 : 1;
    }
    // Secondary: De-prioritize "Upcoming" items
    if (a.isUpcoming !== b.isUpcoming) {
      return a.isUpcoming ? 1 : -1;
    }
    return 0;
  });
  
  const sortedResults = filteredResults.map(p => p.originalItem);
  // STEP 4: APPLY AGE RATING FILTERING
  let ageFilteredResults = sortedResults;
  if (config.ageRating && config.ageRating.toLowerCase() !== 'none') {
    const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
    const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
    const movieToTvMap = { 'G': 'TV-G', 'PG': 'TV-PG', 'PG-13': 'TV-14', 'R': 'TV-MA', 'NC-17': 'TV-MA' };

    ageFilteredResults = sortedResults.filter(result => {
      const cert = result.certification;
      
      const isTvRating = type === 'series';
      const userRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
      const isUserRatingRestrictive = userRating === 'PG-13' || 
                                     (movieRatingHierarchy.indexOf(userRating) !== -1 && 
                                      movieRatingHierarchy.indexOf(userRating) <= movieRatingHierarchy.indexOf('PG-13')) ||
                                     (tvRatingHierarchy.indexOf(userRating) !== -1 && 
                                      tvRatingHierarchy.indexOf(userRating) <= tvRatingHierarchy.indexOf('TV-14'));
      
      if (!cert || cert === "" || cert.toLowerCase() === 'nr') {
        return !isUserRatingRestrictive;
      }
      
      const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
      const userRatingIndex = ratingHierarchy.indexOf(userRating);
      const resultRatingIndex = ratingHierarchy.indexOf(cert);
      
      if (userRatingIndex === -1) return true;
      if (resultRatingIndex === -1) return true;
      
      return resultRatingIndex <= userRatingIndex;
    });
    
    logger.debug(`TVDB filtered ${finalResults.length} results to ${ageFilteredResults.length} based on age rating: ${config.ageRating}`);
  }
  logger.info(`TVDB people search results completed in ${Date.now() - searchStartTime}ms`);

  return ageFilteredResults;
}

async function performTvmazeSearch(query, language, config, searchPersons = true) {
  // Check if query is an IMDb ID
  if (isImdbId(query)) {
    logger.info(`Detected IMDb ID: ${query}, using TVMaze getShowByImdbId`);
    try {
      const imdbId = query.trim();
      const show = await tvmaze.getShowByImdbId(imdbId);
      
      if (!show) {
        logger.info(`No TVMaze show found for IMDb ID ${imdbId}`);
        return [];
      }
      
      // Parse and return the result
      const parsed = await parseTvmazeResult(show, config);
      return parsed ? [parsed] : [];
    } catch (error) {
      logger.error(`Error searching TVMaze by IMDb ID ${query}:`, error.message);
      return [];
    }
  }
  
  const sanitizedQuery = sanitizeTvmazeQuery(query);
  if (!sanitizedQuery) return [];

  const shouldSearchPersons = (() => {
    if (!searchPersons) return false;
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
  // Top Poster API only supports IMDb and TMDB IDs, not TVDB
  // Use IMDb or TMDB ID if available when Top Poster API is selected
  let posterProxyId = imdbId || (tvdbId ? `tvdb:${tvdbId}` : null);
  if (config.posterRatingProvider === 'top') {
    if (imdbId || tmdbId) {
      posterProxyId = imdbId || `tmdb:${tmdbId}`;
    } else {
      // Top Poster API doesn't support TVDB, fall back to regular poster
      posterProxyId = null;
    }
  }
  const posterProxyUrl = posterProxyId 
    ? Utils.buildPosterProxyUrl(host, 'series', posterProxyId, show.image?.original || '', show.language, config)
    : fallbackImage;
  const logoUrl = imdbId ? imdb.getLogoFromImdb(imdbId) : tvdbId ? await tvdb.getSeriesLogo(tvdbId, config) : null;
  return {
    id: stremioId,
    type: 'series',
    name: show.name,
    poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : fallbackImage,
    background: show.image?.original ? `${show.image.original}` : null,
    description: Utils.addMetaProviderAttribution(show.summary ? show.summary.replace(/<[^>]*>?/gm, '') : '', 'TVmaze', config),
    genres: show.genres || [],
    logo: logoUrl,
    year: show.premiered ? show.premiered.substring(0, 4) : '',
    imdbRating: imdbId ? (await getImdbRating(imdbId, 'series')) : show.rating?.average ? show.rating.average.toFixed(1) : 'N/A'
  };
}


/**
 * Perform Trakt search for movies or series 
 * Note: Trakt search doesn't support pagination (page parameter is ignored),
 * so we return a flat 30 results from a single API call.
 */
async function performTraktSearch(type, query, language, config) {
  const startTime = Date.now();
  logger.info(`Starting Trakt search for type "${type}" with query: "${query}"`);

  try {
    const { fetchTraktSearchItems } = require('../utils/traktUtils.js');
    const searchType = type === 'movie' ? 'movie' : 'show';
    const rawResults = new Map();
    
    const addRawResult = (media) => {
      if (media && media.ids) {
        if (!rawResults.has(media.ids.trakt)) {
          media.media_type = searchType;
          rawResults.set(media.ids.trakt, media);
        }
      }
    };

    const titleResults = await fetchTraktSearchItems(searchType, query, config);
    
    if (titleResults && titleResults.length > 0) {
      titleResults.forEach(item => {
        const media = item[searchType];
        if (media) {
          addRawResult(media);
        }
      });
    }

    logger.debug(`Trakt gathered ${rawResults.size} unique potential results in ${Date.now() - startTime}ms`);

    if (rawResults.size === 0) {
      logger.info(`No Trakt results found for query: "${query}"`);
      return [];
    }

    const allResults = Array.from(rawResults.values());
    
    // Sort by votes (descending)
    const sortedResults = [...allResults].sort((a, b) => {
      const aVotes = (a.votes !== undefined && a.votes !== null) ? a.votes : 0;
      const bVotes = (b.votes !== undefined && b.votes !== null) ? b.votes : 0;
      return bVotes - aVotes;
    });

    const limitedResults = sortedResults.slice(0, 30);

    logger.debug(`Trakt limiting results to ${limitedResults.length}, sorted by votes`);

    const metas = await Promise.all(
      limitedResults.map(async (media) => {
        try {
          const ids = media.ids || {};
          const imdbId = ids.imdb;
          const tmdbId = ids.tmdb;
          const tvdbId = ids.tvdb;

          let allIds = {
            tmdbId: tmdbId,
            imdbId: imdbId,
            tvdbId: tvdbId
          };
          if(!imdbId && tmdbId && !tvdbId) {
            allIds = await resolveAllIds(
              `tmdb:${tmdbId}`,
              type,
              config,
              allIds,
              ['imdb']
            );
          }
          else if(!imdbId && tvdbId && !tmdbId) {
            allIds = await resolveAllIds(
              `tvdb:${tvdbId}`,
              type,
              config,
              allIds,
              ['imdb']
            );
          }

          let stremioId = imdbId  || `tmdb:${tmdbId}` || `tvdb:${tvdbId}`;

          const fallbackImage = `${host}/missing_poster.png`;
          const posterArray = media.images?.poster || [];
          const fanartArray = media.images?.fanart || [];
          const logoArray = media.images?.logo || [];
          
          const normalizeImageUrl = (url) => {
            if (!url) return null;
            if (url.startsWith('http://') || url.startsWith('https://')) return url;
            return `https://${url}`;
          };
          
          let posterUrl = posterArray.length > 0 ? normalizeImageUrl(posterArray[0]) : fallbackImage;
          let backgroundUrl = fanartArray.length > 0 ? normalizeImageUrl(fanartArray[0]) : null;
          let logoUrl = logoArray.length > 0 ? normalizeImageUrl(logoArray[0]) : null;
          
          if (!logoUrl) {
            if (imdbId) {
              logoUrl = imdb.getLogoFromImdb(imdbId);
            }
          }

          const validPosterUrl = posterUrl && posterUrl !== 'null' && !posterUrl.includes('undefined') 
            ? posterUrl 
            : fallbackImage;
          
          let posterProxyId = imdbId || (type === 'movie' ? `tmdb:${tmdbId}` : `tvdb:${tvdbId}`);
          if (config.posterRatingProvider === 'top' && !imdbId && !tmdbId) {
            posterProxyId = null; 
          }
          const posterProxyUrl = posterProxyId 
            ? Utils.buildPosterProxyUrl(host, type, posterProxyId, validPosterUrl, language, config)
            : validPosterUrl;

          const imdbRating = allIds.imdbId ? await getImdbRating(allIds.imdbId, type) : 'N/A';

          let releaseDates = null;
          if (type === 'movie' && tmdbId && config.hideUnreleasedDigitalSearch) {
            try {
              const movieDetails = await moviedb.movieInfo({ id: tmdbId, language, append_to_response: "release_dates" }, config);
              releaseDates = movieDetails.release_dates;
            } catch (error) {
              logger.debug(`Failed to get TMDB release dates for movie ${tmdbId}: ${error.message}`);
            }
          }

          const certification = media.certification || null;

          const meta = {
            id: stremioId,
            type: type,
            name: media.title || media.name,
            poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : posterUrl,
            background: backgroundUrl,
            description: Utils.addMetaProviderAttribution(media.overview || '', 'Trakt', config),
            certification: certification,
            logo: logoUrl,
            genres: media.genres || [],
            year: media.year || null,
            imdbRating: imdbRating,
            runtime: type === 'movie' ? Utils.parseRunTime(media.runtime) : null,
            status: type === 'series' ? (media.status || null) : null
          };

          if (releaseDates) {
            meta.app_extras = { releaseDates: releaseDates };
          }

          return meta;
        } catch (error) {
          logger.error(`Error parsing Trakt result:`, error.message);
          return null;
        }
      })
    );

    const validMetas = metas.filter(Boolean);
    
    let finalMetas = validMetas;
    
    if (config.ageRating && config.ageRating.toLowerCase() !== 'none') {
      const beforeCount = finalMetas.length;
      const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
      const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
      const movieToTvMap = { 'G': 'TV-G', 'PG': 'TV-PG', 'PG-13': 'TV-14', 'R': 'TV-MA', 'NC-17': 'TV-MA' };

      finalMetas = finalMetas.filter(result => {
        const cert = result.certification;
        
        const isTvRating = type === 'series';
        const userRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
        const isUserRatingRestrictive = userRating === 'PG-13' || 
                                       (movieRatingHierarchy.indexOf(userRating) !== -1 && 
                                        movieRatingHierarchy.indexOf(userRating) <= movieRatingHierarchy.indexOf('PG-13')) ||
                                       (tvRatingHierarchy.indexOf(userRating) !== -1 && 
                                        tvRatingHierarchy.indexOf(userRating) <= tvRatingHierarchy.indexOf('TV-14'));
        
        if (!cert || cert === "" || cert.toLowerCase() === 'nr') {
          return !isUserRatingRestrictive; 
        }
        
        const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
        const userRatingIndex = ratingHierarchy.indexOf(userRating);
        const resultRatingIndex = ratingHierarchy.indexOf(cert);
        
        if (userRatingIndex === -1) return true; 
        if (resultRatingIndex === -1) return true; 
        
        return resultRatingIndex <= userRatingIndex;
      });
      
      const afterCount = finalMetas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Age rating filter (Trakt): filtered out ${beforeCount - afterCount} results`);
      }
    }
    
    if (type === 'movie' && config.hideUnreleasedDigitalSearch) {
      const beforeCount = finalMetas.length;
      finalMetas = finalMetas.filter(meta => Utils.isReleasedDigitally(meta));
      const afterCount = finalMetas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Digital release filter (Trakt): filtered out ${beforeCount - afterCount} unreleased movies`);
      }
    }
    
    logger.success(`Completed Trakt search for "${query}" in ${Date.now() - startTime}ms. Returning ${finalMetas.length} results.`);
    return finalMetas;

  } catch (error) {
    logger.error(`Trakt search failed for "${query}":`, error.message);
    return [];
  }
}

async function performMdbListSearch(type, query, language, config) {
  const startTime = Date.now();
  logger.info(`Starting MDBList search for type "${type}" with query: "${query}"`);
  if (!config.apiKeys.mdblist) {
    logger.error(`MDBList API key not found in config`);
    return [];
  }
  try {
    const { fetchMdbListSearchItems, fetchMDBListBatchMediaInfo }  = require('../utils/mdbList.js');

    const searchType = type === 'movie' ? 'movie' : 'show';
    const rawResults = new Map();
    
    const addRawResult = (media) => {
      if (media && media.ids) {
        if (media.ids.tmdbid && !rawResults.has(media.ids.tmdbid)) {
          media.media_type = searchType;
          rawResults.set(media.ids.tmdbid, media);
        }
      }
    };

    const titleResults = await fetchMdbListSearchItems(query, searchType, config.apiKeys.mdblist);
    
    if (titleResults?.length) {
      titleResults.forEach(item => addRawResult(item));
    }

    logger.debug(`MDBList gathered ${rawResults.size} unique potential results in ${Date.now() - startTime}ms`);

    if (rawResults.size === 0) {
      logger.info(`No MDBList results found for query: "${query}"`);
      return [];
    }

    const allResults = Array.from(rawResults.values());

    const tmdbIds = allResults
      .map(m => m?.ids?.tmdbid)
      .filter(Boolean);

    const batchMediaInfo = await fetchMDBListBatchMediaInfo(
      "tmdb",
      searchType,
      tmdbIds,
      config.apiKeys.mdblist
    );

    const metas = await Promise.all(batchMediaInfo.map(async (media) => {

      let releaseDates = null;
      if (type === 'movie' && media.ids?.tmdb && config.hideUnreleasedDigitalSearch) {
        try {
          const movieDetails = await moviedb.movieInfo({ id: media.ids?.tmdb, language, append_to_response: "release_dates" }, config);
          releaseDates = movieDetails.release_dates;
        } catch (error) {
          logger.debug(`Failed to get TMDB release dates for movie ${media.ids?.tmdb}: ${error.message}`);
        }
      }
      let logoUrl;
      if (media.ids?.imdb) {
        logoUrl = imdb.getLogoFromImdb(media.ids.imdb);
      } 
      const posterUrl = media.poster || `${host}/missing_poster.png`;
      const fallbackImage = `${host}/missing_poster.png`;
      const validPosterUrl = posterUrl && posterUrl !== 'null' && !posterUrl.includes('undefined') 
            ? posterUrl 
            : fallbackImage;
          
      let posterProxyId = media.ids?.imdb || (type === 'movie' ? `tmdb:${media.ids?.tmdb}` : `tvdb:${media.ids?.tvdb}`);
      if (config.posterRatingProvider === 'top' && !media.ids?.imdb && !media.ids?.tmdb) {
        posterProxyId = null; 
      }
      const posterProxyUrl = posterProxyId 
        ? Utils.buildPosterProxyUrl(host, type, posterProxyId, validPosterUrl, language, config)
        : validPosterUrl;
        if(media.ids?.imdb?.startsWith('tr')) media.ids.imdb = null;
      const meta = {
        id: media.ids?.imdb || `tmdb:${media.ids?.tmdb}` || `tvdb:${media.ids?.tvdb}`,
        type: type,
        name: media.title || media.name,
        description: Utils.addMetaProviderAttribution(media.description, 'MDBList', config),
        poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : posterUrl,
        logo: logoUrl,
        certification: media.certification || null,
        genres: media.genres.map(genre => genre.title) || [],
        year: media.year || null,
        imdbRating: media.ratings.find(rating => rating.source === 'imdb')?.value || null,
        runtime: type === 'movie' ? Utils.parseRunTime(media.runtime) : null,
        status: type === 'series' ? (media.status || null) : null,
      };
      if (releaseDates) {
        meta.app_extras = { releaseDates: releaseDates };
      }
      return meta;
    }));
    const validMetas = metas.filter(Boolean);
    
    let finalMetas = validMetas;
    
    if (config.ageRating && config.ageRating.toLowerCase() !== 'none') {
      const beforeCount = finalMetas.length;
      const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
      const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
      const movieToTvMap = { 'G': 'TV-G', 'PG': 'TV-PG', 'PG-13': 'TV-14', 'R': 'TV-MA', 'NC-17': 'TV-MA' };

      finalMetas = finalMetas.filter(result => {
        const cert = result.certification;

        const isTvRating = type === 'series';
        const userRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
        const isUserRatingRestrictive = userRating === 'PG-13' || 
                                       (movieRatingHierarchy.indexOf(userRating) !== -1 && 
                                        movieRatingHierarchy.indexOf(userRating) <= movieRatingHierarchy.indexOf('PG-13')) ||
                                       (tvRatingHierarchy.indexOf(userRating) !== -1 && 
                                        tvRatingHierarchy.indexOf(userRating) <= tvRatingHierarchy.indexOf('TV-14'));
        
        if (!cert || cert === "" || cert.toLowerCase() === 'nr') {
          return !isUserRatingRestrictive; 
        }
        
        const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
        const userRatingIndex = ratingHierarchy.indexOf(userRating);
        const resultRatingIndex = ratingHierarchy.indexOf(cert);
        
        if (userRatingIndex === -1) return true; 
        if (resultRatingIndex === -1) return true; 
        
        return resultRatingIndex <= userRatingIndex;
      });
      
      const afterCount = finalMetas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Age rating filter (MDBList): filtered out ${beforeCount - afterCount} results`);
      }
    }
    
    if (type === 'movie' && config.hideUnreleasedDigitalSearch) {
      const beforeCount = finalMetas.length;
      finalMetas = finalMetas.filter(meta => Utils.isReleasedDigitally(meta));
      const afterCount = finalMetas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Digital release filter (MDBList): filtered out ${beforeCount - afterCount} unreleased movies`);
      }
    }
    
    logger.success(`Completed MDBList search for "${query}" in ${Date.now() - startTime}ms. Returning ${finalMetas.length} results.`);
    return finalMetas;
  }
  catch (error) {
    logger.error(`MDBList search failed for "${query}":`, error.message);
    return [];
  }
}

/**
 * Perform Trakt people-only search for movies or series
 * Note: Trakt search doesn't support pagination (page parameter is ignored),
 * flat 30 results from a single API call.
 */
async function performTraktPeopleSearch(type, query, language, config) {
  const startTime = Date.now();
  logger.info(`Starting Trakt people-only search for type "${type}" with query: "${query}"`);

  try {
    const { fetchTraktPersonSearch, fetchTraktPersonCredits } = require('../utils/traktUtils.js');
    const searchType = type === 'movie' ? 'movie' : 'show';
    const rawResults = new Map();
    
    const addRawResult = (media, matchType = 'person') => {
      if (media && media.ids) {
        const existing = rawResults.get(media.ids.trakt);
        if (!existing) {
          media.media_type = searchType;
          media.matchType = matchType;
          rawResults.set(media.ids.trakt, media);
        } else {
          const existingVotes = existing.votes || 0;
          const newVotes = media.votes || 0;
          if (newVotes > existingVotes) {
            media.media_type = searchType;
            media.matchType = matchType;
            rawResults.set(media.ids.trakt, media);
          }
        }
      }
    };

    // Determine if we should search for persons
    const shouldSearchPersons = (() => {
      const invalidNamePattern = /[:()[\]?!$#@&]|\b\d+\b/;
      if (invalidNamePattern.test(query)) {
        logger.debug(`Skipping person search due to invalid characters or numbers: "${query}"`);
        return false;
      }
      return true;
    })();

    const personResults = shouldSearchPersons ? await fetchTraktPersonSearch(query) : [];
    
    if (personResults && personResults.length > 0) {
      const topPerson = personResults[0]?.person;
      if (topPerson && topPerson.ids?.trakt) {
        try {
          logger.debug(`Person found: ${topPerson.name} (Trakt ID: ${topPerson.ids.trakt})`);
          
          const credits = await fetchTraktPersonCredits(topPerson.ids.trakt, searchType, 30);
          
          if (credits && credits.length > 0) {
            credits.forEach(media => {
              addRawResult(media, 'person');
            });
            logger.debug(`Trakt gathered ${credits.length} unique potential results from person search`);
          }
        } catch (error) {
          logger.warn(`Could not fetch person credits for ${topPerson.name}:`, error.message);
        }
      }
    }

    logger.debug(`Trakt people search gathered ${rawResults.size} unique potential results in ${Date.now() - startTime}ms`);

    if (rawResults.size === 0) {
      logger.info(`No Trakt results found for query: "${query}"`);
      return [];
    }

    const allResults = Array.from(rawResults.values());
    
    const sortedResults = [...allResults].sort((a, b) => {
      const aVotes = (a.votes !== undefined && a.votes !== null) ? a.votes : 0;
      const bVotes = (b.votes !== undefined && b.votes !== null) ? b.votes : 0;
      return bVotes - aVotes;
    });

    const limitedResults = sortedResults.slice(0, 30);

    const titleCount = limitedResults.filter(r => r.matchType === 'title').length;
    const personCount = limitedResults.filter(r => r.matchType === 'person').length;
    logger.debug(`Trakt limiting results to ${limitedResults.length} (${titleCount} title, ${personCount} person), sorted by votes`);

    const metas = await Promise.all(
      limitedResults.map(async (media) => {
        try {
          const ids = media.ids || {};
          const imdbId = ids.imdb;
          const tmdbId = ids.tmdb;
          const tvdbId = ids.tvdb;
          const traktId = ids.trakt;

          // Resolve all IDs
          let allIds = {
            tmdbId: tmdbId,
            imdbId: imdbId,
            tvdbId: tvdbId
          };
          if(!imdbId && tmdbId && !tvdbId) {
            allIds = await resolveAllIds(
              `tmdb:${tmdbId}`,
              type,
              config,
              allIds,
              ['imdb']
            );
          }
          else if(!imdbId && tvdbId && !tmdbId) {
            allIds = await resolveAllIds(
              `tvdb:${tvdbId}`,
              type,
              config,
              allIds,
              ['imdb']
            );
          }

          let stremioId = imdbId || (type === 'movie' ? `tmdb:${tmdbId}` : `tvdb:${tvdbId}`);
          if (!stremioId && traktId) {
            stremioId = `trakt:${traktId}`;
          }

          const fallbackImage = `${host}/missing_poster.png`;
          const posterArray = media.images?.poster || [];
          const fanartArray = media.images?.fanart || [];
          const logoArray = media.images?.logo || [];
          
          const normalizeImageUrl = (url) => {
            if (!url) return null;
            if (url.startsWith('http://') || url.startsWith('https://')) return url;
            return `https://${url}`;
          };
          
          let posterUrl = posterArray.length > 0 ? normalizeImageUrl(posterArray[0]) : fallbackImage;
          let backgroundUrl = fanartArray.length > 0 ? normalizeImageUrl(fanartArray[0]) : null;
          let logoUrl = logoArray.length > 0 ? normalizeImageUrl(logoArray[0]) : null;
          
          if (!logoUrl) {
            if (imdbId) {
              logoUrl = imdb.getLogoFromImdb(imdbId);
            }
          }

          // Build poster proxy URL - use same ID pattern as stremioId (matches TMDB search pattern)
          const validPosterUrl = posterUrl && posterUrl !== 'null' && !posterUrl.includes('undefined') 
            ? posterUrl 
            : fallbackImage;
          
          let posterProxyId = imdbId || (type === 'movie' ? `tmdb:${tmdbId}` : `tvdb:${tvdbId}`);
          if (config.posterRatingProvider === 'top' && !imdbId && !tmdbId) {
            posterProxyId = null; // Top Poster API doesn't support TVDB
          }
          const posterProxyUrl = posterProxyId 
            ? Utils.buildPosterProxyUrl(host, type, posterProxyId, validPosterUrl, language, config)
            : validPosterUrl;

          const imdbRating = allIds.imdbId ? await getImdbRating(allIds.imdbId, type) : 'N/A';

          let releaseDates = null;
          if (type === 'movie' && tmdbId && config.hideUnreleasedDigitalSearch) {
            try {
              const movieDetails = await moviedb.movieInfo({ id: tmdbId, language, append_to_response: "release_dates" }, config);
              releaseDates = movieDetails.release_dates;
            } catch (error) {
              logger.debug(`Failed to get TMDB release dates for movie ${tmdbId}: ${error.message}`);
            }
          }

          const certification = media.certification || null;

          const meta = {
            id: stremioId,
            type: type,
            name: media.title || media.name,
            poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : posterUrl,
            background: backgroundUrl,
            description: Utils.addMetaProviderAttribution(media.overview || '', 'Trakt', config),
            certification: certification,
            logo: logoUrl,
            genres: media.genres || [],
            year: media.year || null,
            imdbRating: imdbRating,
            runtime: type === 'movie' ? Utils.parseRunTime(media.runtime) : null,
            status: type === 'series' ? (media.status || null) : null,
            _matchType: media.matchType 
          };

          if (releaseDates) {
            meta.app_extras = { releaseDates: releaseDates };
          }

          return meta;
        } catch (error) {
          logger.error(`Error parsing Trakt result:`, error.message);
          return null;
        }
      })
    );

    const validMetas = metas.filter(Boolean);
    
    let finalMetas = validMetas.map(({ _matchType, ...meta }) => meta);
    
    if (config.ageRating && config.ageRating.toLowerCase() !== 'none') {
      const beforeCount = finalMetas.length;
      const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
      const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
      const movieToTvMap = { 'G': 'TV-G', 'PG': 'TV-PG', 'PG-13': 'TV-14', 'R': 'TV-MA', 'NC-17': 'TV-MA' };

      finalMetas = finalMetas.filter(result => {
        const cert = result.certification;
        
        const isTvRating = type === 'series';
        const userRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
        const isUserRatingRestrictive = userRating === 'PG-13' || 
                                       (movieRatingHierarchy.indexOf(userRating) !== -1 && 
                                        movieRatingHierarchy.indexOf(userRating) <= movieRatingHierarchy.indexOf('PG-13')) ||
                                       (tvRatingHierarchy.indexOf(userRating) !== -1 && 
                                        tvRatingHierarchy.indexOf(userRating) <= tvRatingHierarchy.indexOf('TV-14'));
        
        if (!cert || cert === "" || cert.toLowerCase() === 'nr') {
          return !isUserRatingRestrictive; 
        }
        
        const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
        const userRatingIndex = ratingHierarchy.indexOf(userRating);
        const resultRatingIndex = ratingHierarchy.indexOf(cert);
        
        if (userRatingIndex === -1) return true; 
        if (resultRatingIndex === -1) return true; 
        
        return resultRatingIndex <= userRatingIndex;
      });
      
      const afterCount = finalMetas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Age rating filter (Trakt): filtered out ${beforeCount - afterCount} results`);
      }
    }
    
    // Apply digital release filter for movies only
    if (type === 'movie' && config.hideUnreleasedDigitalSearch) {
      const beforeCount = finalMetas.length;
      finalMetas = finalMetas.filter(meta => Utils.isReleasedDigitally(meta));
      const afterCount = finalMetas.length;
      if (beforeCount !== afterCount) {
        logger.info(`Digital release filter (Trakt): filtered out ${beforeCount - afterCount} unreleased movies`);
      }
    }
    
    logger.success(`Completed Trakt search for "${query}" in ${Date.now() - startTime}ms. Returning ${finalMetas.length} results.`);
    return finalMetas;

  } catch (error) {
    logger.error(`Trakt search failed for "${query}":`, error.message);
    return [];
  }
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
  } else   if (searchId.includes('tvmaze.')) {
    return 'tvmaze';
  } else if (searchId.includes('trakt.')) {
    return 'trakt';
  } else if (searchId.includes('mdblist.')) {
    return 'mdblist';
  } else if (searchId === 'people_search') {
    // For people search, determine the actual provider used based on type and config
    return 'people_search'; // Generic people search - actual provider determined at runtime
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
          metas = await Utils.parseAnimeCatalogMetaBatch(results, config, language, false);
        }
        break;
      
      case 'mal.va_search':
        if (extra.va_id) {
          const roles = await jikan.getAnimeByVoiceActor(extra.va_id);
          const animeResults = roles.map(role => role.anime);
          const batchMetas = await Utils.parseAnimeCatalogMetaBatch(animeResults, config, language, false);
          
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

      case 'gemini.search':
        if (extra.search) {
          const query = extra.search;    
          // Perform single AI search that returns mixed movie/series results
          metas = await performAiSearch(query, language, config);
        }
        break;

      case 'people_search':
        if (extra.search) {
          const query = extra.search;
          let providerId;
          logger.info(`Performing people search for type '${type}' with query '${query}'`);
          if (type === 'movie') {
            providerId = config.search?.providers?.people_search_movie || 'tmdb.people.search';
          } else if (type === 'series') {
            providerId = config.search?.providers?.people_search_series || 'tmdb.people.search';
          }
          
          logger.debug(`Performing people-only search for type '${type}' using provider '${providerId}'`);
          
          switch (providerId) {
              case 'tmdb.people.search':
                metas = await performTmdbPeopleSearch(type, query, language, config, page);
                break;
              case 'tvdb.people.search':
                metas = await performTvdbPeopleSearch(type, query, language, config);
                break;
              case 'trakt.people.search':
                metas = await performTraktPeopleSearch(type, query, language, config);
                break;
          }
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
          // Regular search always uses keyword search providers
          // AI search is now handled by the dedicated 'gemini.search' catalog
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
                metas = await performTmdbSearch(type, query, language, config, false, page);
                break;
              case 'tvdb.search':
                metas = await performTvdbSearch(type, query, language, config);
                break;
              case 'tvdb.collections.search':
                metas = await performTvdbCollectionsSearch(query, language, config);
                break;
              case 'tvmaze.search':
                metas = await performTvmazeSearch(query, language, config, false);
                break;
              case 'trakt.search':
                // Trakt search doesn't support pagination, returns flat 30 results
                metas = await performTraktSearch(type, query, language, config);
                break;
              case 'mdblist.search':
                metas = await performMdbListSearch(type, query, language, config);
                break;
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
        else if (providerId.includes('trakt.')) actualProvider = 'trakt';
        else if (providerId.includes('mdblist.')) actualProvider = 'mdblist';
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
    
    const beforeFilterCount = metas.length;
    metas = metas.filter(meta => {
      if (meta.id && typeof meta.id === 'string' && meta.id.includes('undefined')) {
        logger.debug(`Filtering out search result with bad ID: ${meta.id}`);
        return false;
      }
      if (meta.name === 'undefined' || meta.name === undefined) {
        logger.debug(`Filtering out search result with undefined name`);
        return false;
      }
      if (meta.type === 'undefined' || meta.type === undefined) {
        logger.debug(`Filtering out search result with undefined type`);
        return false;
      }
      return true;
    });
    
    const afterFilterCount = metas.length;
    if (beforeFilterCount !== afterFilterCount) {
      logger.info(`Filtered out ${beforeFilterCount - afterFilterCount} malformed search results`);
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
        else if (providerId.includes('trakt.')) actualProvider = 'trakt';
        else if (providerId.includes('mdblist.')) actualProvider = 'mdblist';
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
