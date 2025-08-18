require("dotenv").config();
const { MovieDb } = require("moviedb-promise");
const { getGenreList } = require("./getGenreList");
const Utils = require("../utils/parseProps");
const tvdb = require("./tvdb");
const { to3LetterCode } = require("./language-map"); 
const jikan = require('./mal');
const moviedb = require('./getTmdb');
const tvmaze = require('./tvmaze');
const { isAnime } = require("../utils/isAnime");
const { performGeminiSearch } = require('../utils/gemini-service');


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
  
  const tmdbId = extendedRecord.remoteIds?.find(id => id.sourceName === 'TheMovieDB')?.id;
  const tvdbId = extendedRecord.id;
  var fallbackImage = extendedRecord.image === null ? "https://artworks.thetvdb.com/banners/images/missing/series.jpg" : extendedRecord.image;
  const posterUrl = await Utils.getSeriesPoster({ tmdbId: tmdbId, tvdbId: tvdbId, metaProvider: 'tvdb', fallbackPosterUrl: fallbackImage }, config);
  const posterProxyUrl = `${host}/poster/series/tvdb:${tvdbId}?fallback=${encodeURIComponent(posterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
  return {
    id: `tvdb:${extendedRecord.id}`,
    type: type,
    name: translatedName, 
    poster: config.apiKeys?.rpdb ? posterProxyUrl : posterUrl,
    year: extendedRecord.year,
    description: overview,
    //isAnime: isAnime(extendedRecord)
  };
}

async function performAnimeSearch(type, query, language, config, page = 1) {
  let searchResults = [];
  switch(type){
    case 'movie':
      searchResults = await jikan.searchAnime('movie', query, 25, config);
      break;
    case 'series':
      const desiredTvTypes = new Set(['tv', 'ova', 'ona']);
      searchResults = await jikan.searchAnime('anime', query, 25, config);
      searchResults = searchResults.filter(item => {
        return typeof item?.type === 'string' && desiredTvTypes.has(item.type.toLowerCase());
      });
      break;
    default:
      const desiredTypes = new Set(['tv', 'movie', 'ova', 'ona']);
      searchResults = await jikan.searchAnime('anime', query, 25, config, page);
      searchResults = searchResults.filter(item => {
    return typeof item?.type === 'string' && desiredTypes.has(item.type.toLowerCase());
  });
      break;

  }
  
  // Use batch processing for better performance and to avoid rate limits
  const metas = await Utils.parseAnimeCatalogMetaBatch(searchResults, config, language);
  //console.log(metas); 
  return metas;
}


async function performTmdbSearch(type, query, language, config, searchPersons = true) {
    const searchResults = new Map();
    const rawResults = new Map();

    const addRawResult = (media) => {
        if (media && !media.media_type) {
            media.media_type = type;
        }
        if (media && media.id && !rawResults.has(media.id)) {
            rawResults.set(media.id, media);
        }
    };

    if (type === 'movie') {
        const movieRes = await moviedb.searchMovie({ query, language, include_adult: config.includeAdult }, config);
        movieRes.results.forEach(addRawResult);
    } else { 
        const seriesRes = await moviedb.searchTv({ query, language, include_adult: config.includeAdult }, config);
        seriesRes.results.forEach(addRawResult);
    }
    
    if (searchPersons){
      const personRes = await moviedb.searchPerson({ query, language }, config);
      if (personRes.results?.[0]) {
          const credits = type === 'movie' ? 
             await moviedb.personMovieCredits({ id: personRes.results[0].id, language }, config) : await moviedb.personTvCredits({ id: personRes.results[0].id, language }, config);
          credits.cast.forEach(addRawResult);
          credits.crew.forEach(media => { if (media.job === "Director" || media.job === "Writer") addRawResult(media); });
      }
    }

    const genreType = type ==='movie' ? 'movie' : 'series'
    const genreList = await getGenreList('tmdb', language, genreType, config);

    const hydrationPromises = Array.from(rawResults.values()).map(async (media) => {
        const mediaType = media.media_type === 'tv' ? 'series' : 'movie';
        
        const parsed = Utils.parseMedia(media, media.media_type, genreList); 
        if (!parsed) return null;

        const tmdbPosterFullUrl = media.poster_path
            ? `https://image.tmdb.org/t/p/w500${media.poster_path}`
            : `https://artworks.thetvdb.com/banners/images/missing/series.jpg`; 
        const posterUrl = await Utils.getSeriesPoster({ tmdbId: media.id, tvdbId: null, metaProvider: 'tmdb', fallbackPosterUrl: tmdbPosterFullUrl }, config);

        const posterProxyUrl = `${host}/poster/${mediaType}/tmdb:${media.id}?fallback=${encodeURIComponent(posterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;

        parsed.poster = config.apiKeys?.rpdb ? posterProxyUrl : posterUrl;
        parsed.popularity = media.popularity;
        return parsed;
    });

    const hydratedMetas = (await Promise.all(hydrationPromises)).filter(Boolean);

    hydratedMetas.forEach(parsed => {
        if (parsed.type === type && !searchResults.has(parsed.id)) {
            searchResults.set(parsed.id, parsed);
        }
    });

    const finalResults = Array.from(searchResults.values());
    return Utils.sortSearchResults(finalResults, query);
}


async function performAiSearch(type, query, language, config) {
  const aiSuggestions = await performGeminiSearch(config.geminikey, query, type, language);
  if (!aiSuggestions || aiSuggestions.length === 0) {
    console.log('[AI Search] Gemini returned no suggestions.');
    return [];
  }
  console.log('[AI Search] Gemini suggested:', JSON.stringify(aiSuggestions, null, 2));

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
          const searchResults = await tvdb.searchSeries(searchTitle, config);
          const topMatchId = searchResults?.[0]?.tvdb_id;
          if (topMatchId) {
            const extendedRecord = await tvdb.getSeriesExtended(topMatchId, config);
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
      console.error(`[AI Search] Failed to process suggestion "${title}":`, error.message);
      continue; 
    }
  }

  return finalMetas;
}

async function performTvdbSearch(type, query, language, config) {
  const sanitizedQuery = sanitizeQuery(query);
  if (!sanitizedQuery) return [];

  const idMap = new Map(); 

  let titleResults = [];
  if (type === 'movie') {
    titleResults = await tvdb.searchMovies(sanitizedQuery, config);
  } else { 
    titleResults = await tvdb.searchSeries(sanitizedQuery, config);
  }

  (titleResults || []).forEach(result => {
    const resultId = result.tvdb_id || result.id;
    if (resultId) {
      idMap.set(String(resultId), type);
    }
  });

  const peopleResults = await tvdb.searchPeople(sanitizedQuery, config);
  if (peopleResults && peopleResults.length > 0) {
    const topPerson = peopleResults[0];
    try {
      const personDetails = await tvdb.getPersonExtended(topPerson.tvdb_id, config);
      if (personDetails && personDetails.characters) {
        personDetails.characters.forEach(credit => {

          const creditType = credit.type === 'series' ? 'series' : 'movie';
          const creditId = credit.seriesId || credit.movieId;
          if (creditId) {
            idMap.set(String(creditId), creditType);
          }
        });
      }
    } catch (e) {
      console.warn(`[TVDB Search] Could not fetch person details for ${topPerson.name}:`, e.message);
    }
  }
  

  const uniqueEntries = Array.from(idMap.entries());
  if (uniqueEntries.length === 0) {
    return [];
  }

  const detailPromises = uniqueEntries.map(([id, itemType]) => {
    if (itemType === 'movie') {
      return tvdb.getMovieExtended(id, config);
    }
    return tvdb.getSeriesExtended(id, config);
  });
  
  const detailedResults = await Promise.allSettled(detailPromises);
  const parsePromises = detailedResults
    .filter(res => res.status === 'fulfilled' && res.value)
    .map(res => {
        return parseTvdbSearchResult(type, res.value, language, config);
    });
    
  const finalResults = (await Promise.all(parsePromises)).filter(Boolean);

  const filteredResults = finalResults.filter(item => item.type === type);

  return Utils.sortSearchResults(filteredResults, query);
}

async function performTvmazeSearch(query, language, config) {
  const sanitizedQuery = sanitizeTvmazeQuery(query);
  if (!sanitizedQuery) return [];

  const [titleResults, peopleResults] = await Promise.all([
    tvmaze.searchShows(sanitizedQuery),
    tvmaze.searchPeople(sanitizedQuery)
  ]);
  
  const searchResults = new Map();
  const addResult = (show) => {
    const parsed = parseTvmazeResult(show, config);
    if (parsed && show?.id && !searchResults.has(show.id)) {
      searchResults.set(show.id, parsed);
    }
  };

  titleResults.forEach(result => addResult(result.show));

  if (peopleResults.length > 0) {
    const personId = peopleResults[0].person.id;
    const castCredits = await tvmaze.getPersonCastCredits(personId);
    castCredits.forEach(credit => addResult(credit._embedded.show));
  }
  
  if (searchResults.size > 0) {
    return Array.from(searchResults.values());
  }
  
  // --- TIER 2 & 3 FALLBACKS ---
  console.log(`Initial searches failed for "${query}". Trying fallback tiers...`);
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

function parseTvmazeResult(show, config) {
  if (!show || !show.id || !show.name) return null;

  const imdbId = show.externals?.imdb;
  var fallbackImage = show.image === null ? "https://artworks.thetvdb.com/banners/images/missing/series.jpg" : show.image.original;
  const posterProxyUrl = `${host}/poster/series/${imdbId}?fallback=${encodeURIComponent(show.image?.original || '')}&lang=${show.language}&key=${config.apiKeys?.rpdb}`;
  return {
    id: `tvmaze:${show.id}`,
    type: 'series',
    name: show.name,
    poster: show.image ? show.image.medium : null,
    background: config.apiKeys?.rpdb ? posterProxyUrl : fallbackImage,
    description: show.summary ? show.summary.replace(/<[^>]*>?/gm, '') : '',
    genres: show.genres || [],
    year: show.premiered ? show.premiered.substring(0, 4) : '',
    imdbRating: show.rating?.average ? show.rating.average.toFixed(1) : 'N/A'
  };
}


async function getSearch(id, type, language, extra, config) {
  const timerLabel = `Search for "${JSON.stringify(extra)}" (type: ${id})`;
  try {
    if (!extra) {
      console.warn(`Search request for id '${id}' received with no 'extra' argument.`);
      return { metas: [] };
    }

    const queryText = extra.search || extra.genre_id || extra.va_id || 'N/A';
    console.time(timerLabel);

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
        console.log(`[getSearch] Performing mal.search.series search for series: ${extra.search}`);
        if (extra.search) {
          metas = await performAnimeSearch('series', extra.search, language, config);
        }
        break;  
      case 'mal.search.movie':
        console.log(`[getSearch] Performing mal.search.movie search for movies: ${extra.search}`);
        if (extra.search) {
          metas = await performAnimeSearch('movie', extra.search, language, config);
        }
        break;*/

      case 'search':
        if (extra.search) {
          const query = extra.search;
          let providerId;
          console.log(`[getSearch] Performing search for type '${type}' with query '${query}'`);
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
            console.log(`[getSearch] Performing AI-enhanced search for type '${type}'`);
            metas = await performAiSearch(type, query, language, config);
          } else {
            console.log(`[getSearch] Performing direct keyword search for type '${type}' using provider '${providerId}'`);

            switch (providerId) {
              case 'mal.search.series':
                metas = await performAnimeSearch('series', query, language, config, page);
                break;
              case 'mal.search.movie':
                metas = await performAnimeSearch('movie', query, language, config, page);
                break;
              case 'tmdb.search':
                metas = await performTmdbSearch(type, query, language, config);
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
        console.warn(`[getSearch] Received unknown search ID: '${id}'`);
        break;
    }

    console.timeEnd(timerLabel);
    return { metas };
  } catch (error) {
    console.timeEnd(timerLabel);
    console.error(`Error during search for id "${id}":`, error);
    return { metas: [] };
  }
}


module.exports = { getSearch };
