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
const { resolveAllIds } = require('./id-resolver');
const { isAnime } = require("../utils/isAnime");
const { performGeminiSearch } = require('../utils/gemini-service');
const consola = require('consola');

const logger = consola.create({ 
  level: 4, // Show all levels
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
  var fallbackImage = extendedRecord.image === null ? "https://artworks.thetvdb.com/banners/images/missing/series.jpg" : extendedRecord.image;
  const posterUrl = fallbackImage;
  
  // Validate poster URL to prevent malformed URLs
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
  
  let preferredProvider;
  if (type === 'movie') {
    preferredProvider = config.providers?.movie || 'tmdb';
  } else {
    preferredProvider = config.providers?.series || 'tvdb';
  }
  let stremioId;
  if (preferredProvider === 'tvmaze' && tvmazeId) {
    stremioId = `tvmaze:${tvmazeId}`;
  }
   else if (preferredProvider === 'tmdb' && tmdbId) {
    stremioId = `tmdb:${tmdbId}`;
  } else if (preferredProvider === 'imdb' && imdbId) {
    stremioId = imdbId;
  } else {
    stremioId = `tvdb:${extendedRecord.id}`; // fallback
  }
  const logoUrl = type === 'series' ? extendedRecord.artworks?.find(a => a.type === 23)?.image : extendedRecord.artworks?.find(a => a.type === 25)?.image;
  // Validate logo URL to prevent malformed URLs
  const validLogoUrl = logoUrl && typeof logoUrl === 'string' && !logoUrl.includes('undefined') && logoUrl !== 'null' ? logoUrl : imdbId? imdb.getLogoFromImdb(imdbId) : null;
  return {
    id: stremioId,
    type: type,
    name: translatedName, 
    poster: config.apiKeys?.rpdb ? posterProxyUrl : validPosterUrl,
    year: extendedRecord.year,
    description: Utils.addMetaProviderAttribution(overview, 'TVDB', config),
    certification: certification,
    logo: validLogoUrl,
    genres: extendedRecord.genres?.map(g => g.name) || [],
    imdbRating: imdbId ? await getImdbRating(imdbId, type) : 'N/A',
    //isAnime: isAnime(extendedRecord)
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
      const desiredTvTypes = new Set(['tv', 'ova', 'ona', 'tv special']);
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
                if (!topPerson.name.toLowerCase().includes(query.toLowerCase())) {
                  logger.debug(`Skipping person ${topPerson.name} because it doesn't match the query: "${query}"`);
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
  titleRes.results.forEach(media => {
      media.matchType = 'title'; // Tag as a direct title match
      addRawResult(media);
  });
  personCredits.forEach(media => {
      media.matchType = 'person'; // Tag as a match from a person's filmography
      addRawResult(media);
  });
  // number of results from people search
  logger.debug(`TMDB gathered ${personCredits.length} unique potential results from people search in ${Date.now() - startTime}ms`);
  logger.debug(`TMDB gathered ${rawResults.size} unique potential results in ${Date.now() - startTime}ms`);
  const sortedRawResults = Utils.sortSearchResults(Array.from(rawResults.values()), query).slice(0, 25);

  // STEP 2: HYDRATE ALL RESULTS IN PARALLEL
  const genreList = await getGenreList('tmdb', language, type, config);

  const hydrationPromises = sortedRawResults.map(async (media) => {
    try {
        const mediaType = media.media_type === 'movie' ? 'movie' : 'series';
        // Filter out items that don't match the search type (e.g., a movie found in an actor's TV credits)
        if(mediaType !== type) {
          logger.debug(`Filtering out ${media.title || media.name} - mediaType: ${mediaType}, searchType: ${type}`);
          return null;
        }

        let logoUrl; let backgroundUrl; let posterUrl;
        // OPTIMIZATION: Fetch details, external_ids, and certifications in ONE call
        const details = mediaType === 'movie'
            ? await moviedb.movieInfo({ id: media.id, language, append_to_response: "external_ids,release_dates, images", include_image_language: null }, config)
            : await moviedb.tvInfo({ id: media.id, language, append_to_response: "external_ids,content_ratings, images", include_image_language: null }, config);
        
        const allIds = {
            tmdbId: details.id,
            imdbId: details.external_ids?.imdb_id,
            tvdbId: details.external_ids?.tvdb_id
        };
        logoUrl = details.images?.logos?.[0]?.file_path ? `https://image.tmdb.org/t/p/original${details.images?.logos?.[0]?.file_path}` : null;
        backgroundUrl = details.images?.backdrops?.[0]?.file_path ? `https://image.tmdb.org/t/p/original${details.images?.backdrops?.[0]?.file_path}` : null;
        posterUrl = media.poster_path ? `${TMDB_IMAGE_BASE}${media.poster_path}` : `https://artworks.thetvdb.com/banners/images/missing/${mediaType}.jpg`;

        // OPTIMIZATION: Fetch poster, rating, logo, and resolve final stremio ID in parallel
        const [imdbRating, resolvedIds] = await Promise.all([
            allIds.imdbId ? getImdbRating(allIds.imdbId, mediaType) : Promise.resolve(null),
            resolveAllIds(`tmdb:${media.id}`, mediaType, config)
        ]);
        
        // Debug: Check for malformed poster URLs
        if (!posterUrl || posterUrl === 'null' || posterUrl.includes('undefined')) {
          logger.warn(`Malformed poster URL for ${media.title || media.name}: ${posterUrl}`);
        }
        
        // Ensure we always have a valid poster URL
        const validPosterUrl = posterUrl && posterUrl !== 'null' && !posterUrl.includes('undefined') 
          ? posterUrl 
          : `https://artworks.thetvdb.com/banners/images/missing/${mediaType}.jpg`;
        
        const posterProxyUrl = `${host}/poster/${mediaType}/tmdb:${media.id}?fallback=${encodeURIComponent(validPosterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
        
        // Determine the final Stremio ID based on user preference
        const preferredProvider = type === 'movie' ? (config.providers?.movie || 'tmdb') : (config.providers?.series || 'tvdb');
        let stremioId = `tmdb:${media.id}`; // Default to TMDB
        if (preferredProvider === 'tvdb' && resolvedIds?.tvdbId) stremioId = `tvdb:${resolvedIds.tvdbId}`;
        else if (preferredProvider === 'tvmaze' && resolvedIds?.tvmazeId) stremioId = `tvmaze:${resolvedIds.tvmazeId}`;
        else if (preferredProvider === 'imdb' && resolvedIds?.imdbId) stremioId = resolvedIds.imdbId;
        
        // Assemble the final meta object
        const parsed = Utils.parseMedia(media, mediaType, genreList, config);
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
        return parsed;
    } catch (error) {
        logger.error(`Failed to hydrate TMDB item ${media.id} (${media.title || media.name}):`, error);
        return null;
    }
  });

  const hydratedMetas = (await Promise.all(hydrationPromises)).filter(Boolean);
  logger.info(`Hydration complete in ${Date.now() - startTime}ms. Found ${hydratedMetas.length} valid items.`);

  // STEP 3: FINAL SORTING AND FILTERING (your existing logic is good)
  
  
  let filteredResults = hydratedMetas;
  if (config.ageRating && config.ageRating.toLowerCase() !== 'none') {
      const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
      const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
      const movieToTvMap = { 'G': 'TV-G', 'PG': 'TV-PG', 'PG-13': 'TV-14', 'R': 'TV-MA', 'NC-17': 'TV-MA' };

      filteredResults = filteredResults.filter(result => {
          if (!result.certification) return true;
          
          const isTvRating = type === 'series';
          const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
          const userRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
          
          const userRatingIndex = ratingHierarchy.indexOf(userRating);
          const resultRatingIndex = ratingHierarchy.indexOf(result.certification);
          
          if (userRatingIndex === -1) return true;
          if (resultRatingIndex === -1) return false;
          
          return resultRatingIndex <= userRatingIndex;
      });
      logger.debug(`Age rating filter applied: ${sortedResults.length} -> ${filteredResults.length} results.`);
  }

  logger.success(`Completed TMDB search for "${query}" in ${Date.now() - startTime}ms. Returning ${filteredResults.length} results.`);
  return filteredResults;
}


async function performAiSearch(type, query, language, config) {
  const aiSuggestions = await performGeminiSearch(config.geminikey, query, type, language);
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
      else if (type === 'movie') {
        const searchTitle = suggestion.title;
        if (searchTitle) {
          const results = await performMovieSearch(type, searchTitle, language, config, false);
          parsedResult = results?.[0] || null;
        }
      }

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

async function performTvdbSearch(type, query, language, config) {
  const sanitizedQuery = sanitizeQuery(query);
  if (!sanitizedQuery) return [];

  const idMap = new Map(); 

  // STEP 1: GATHER IDs FROM TITLE AND PEOPLE SEARCHES IN PARALLEL
  const searchStartTime = Date.now();
  logger.info(`Starting TVDB parallel search for: "${sanitizedQuery}"`);

  const [titleResults, peopleResults] = await Promise.all([
    type === 'movie' 
      ? tvdb.searchMovies(sanitizedQuery, config) 
      : tvdb.searchSeries(sanitizedQuery, config),
    tvdb.searchPeople(sanitizedQuery, config)
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
  const parsePromises = detailedResults.map(record =>
    parseTvdbSearchResult(type, record, language, config)
  );
    
  const finalResults = (await Promise.all(parsePromises)).filter(Boolean);
  logger.info(`Successfully parsed ${finalResults.length} items into Stremio metas.`);

  // STEP 4: APPLY AGE RATING FILTERING
  let ageFilteredResults = finalResults;
  if (config.ageRating && config.ageRating.toLowerCase() !== 'none') {
    const movieRatingHierarchy = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
    const tvRatingHierarchy = ["TV-Y", "TV-Y7", "TV-G", "TV-PG", "TV-14", "TV-MA"];
    const movieToTvMap = { 'G': 'TV-G', 'PG': 'TV-PG', 'PG-13': 'TV-14', 'R': 'TV-MA', 'NC-17': 'TV-MA' };

    ageFilteredResults = finalResults.filter(result => {
      if (!result.certification) return true;
      
      const isTvRating = type === 'series';
      const ratingHierarchy = isTvRating ? tvRatingHierarchy : movieRatingHierarchy;
      const userRating = isTvRating ? (movieToTvMap[config.ageRating] || config.ageRating) : config.ageRating;
      
      const userRatingIndex = ratingHierarchy.indexOf(userRating);
      const resultRatingIndex = ratingHierarchy.indexOf(result.certification);
      
      if (userRatingIndex === -1) return true; // If user rating is invalid, don't filter
      if (resultRatingIndex === -1) return false; // Filter out items with unrecognized ratings
      
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

  const [titleResults, peopleResults] = await Promise.all([
    tvmaze.searchShows(sanitizedQuery),
    tvmaze.searchPeople(sanitizedQuery)
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
  if (tmdbResults.results.length > 0) {
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
  const preferredProvider = config.providers?.series || 'tvdb';
  let stremioId;
  if (preferredProvider === 'tvdb' && tvdbId) {
    stremioId = `tvdb:${tvdbId}`;
  } else if (preferredProvider === 'tmdb' && tmdbId) {
    stremioId = `tmdb:${tmdbId}`;
  } else if (preferredProvider === 'imdb' && imdbId) {
    stremioId = imdbId;
  } else {
    stremioId = `tvmaze:${show.id}`;
  }
  var fallbackImage = show.image?.original || "https://artworks.thetvdb.com/banners/images/missing/series.jpg";
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
  const timerLabel = `Search for "${JSON.stringify(extra)}" (type: ${id}) - ${Date.now()}`;
  const searchStartTime = Date.now();
  try {
    if (!extra) {
      logger.warn(`Search request for id '${id}' received with no 'extra' argument.`);
      return { metas: [] };
    }

    const queryText = extra.search || extra.genre_id || extra.va_id || 'N/A';
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
          }
          
          providerId = providerId || getDefaultProvider(type);
          if (config.search?.ai_enabled && config.geminikey) {
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
              case 'tmdb.search':
                metas = await performTmdbSearch(type, query, language, config, true, page);
                break;
              case 'tvdb.search':
                metas = await performTvdbSearch(type, query, language, config);
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
