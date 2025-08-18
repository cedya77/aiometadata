require("dotenv").config();
const { getGenreList } = require("./getGenreList");
const { getLanguages } = require("./getLanguages");
const { fetchMDBListItems, parseMDBListItems } = require("../utils/mdbList");
const CATALOG_TYPES = require("../static/catalog-types.json");
const { getMeta } = require("./getMeta");
const { isAnime } = require("../utils/isAnime");
const moviedb = require("./getTmdb");
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const TVDB_IMAGE_BASE = 'https://artworks.thetvdb.com';
const tvdb = require('./tvdb');
const { to3LetterCode, to3LetterCountryCode } = require('./language-map');
const Utils = require('../utils/parseProps');
const { getImdbRating } = require('./getImdbRating');
const { resolveAllIds } = require('./id-resolver');

const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

async function getCatalog(type, language, page, id, genre, config, catalogChoices) {
  try {
    if (id.startsWith('tvdb.')) {
      console.log(`[getCatalog] Routing to TVDB catalog handler for id: ${id}`);
      const tvdbResults = await getTvdbCatalog(type, id, genre, page, language, config);
      return { metas: tvdbResults };
    } 
    else if (id.startsWith('tmdb.') || id.startsWith('mdblist.')) {
      console.log(`[getCatalog] Routing to TMDB/MDBList catalog handler for id: ${id}`);
      const tmdbResults = await getTmdbAndMdbListCatalog(type, id, genre, page, language, config, catalogChoices);
      return { metas: tmdbResults };
    }

    else {
      console.warn(`[getCatalog] Received request for unknown catalog prefix: ${id}`);
      return { metas: [] };
    }
  } catch (error) {
    console.error(`Error in getCatalog router for id=${id}, type=${type}:`, error.message);
    return { metas: [] };
  }
}

async function getTvdbCatalog(type, catalogId, genreName, page, language, config) {
  console.log(`[getCatalog] Fetching TVDB catalog: ${catalogId}, Genre: ${genreName}, Page: ${page}`);
  
  const allTvdbGenres = await getGenreList('tvdb', language, type, config);
  const genre = allTvdbGenres.find(g => g.name === genreName);
   const langParts = language.split('-');
  const langCode2 = langParts[0];
  const countryCode2 = langParts[1] || langCode2; 
  const langCode3 = await to3LetterCode(langCode2, config);
  const countryCode3 = to3LetterCountryCode(countryCode2);
  
  const params = {
    country: countryCode3 || 'usa',
    lang: langCode3 || 'eng',
    sort: 'score'
  };

  if (genre) {
    params.genre = genre.id;
  }
  
  const tvdbType = type === 'movie' ? 'movies' : 'series';
  if(tvdbType === 'series'){
    params.sortType = 'desc';
  }
  const results = await tvdb.filter(tvdbType, params, language, config);
  if (!results || results.length === 0) return [];


  const metas = await Promise.all(results.sort((a, b) => b.score - a.score).map(async item => {
    const tvdbId = item.tvdb_id || item.id;
    if (!tvdbId || !item.name) return null;
    const fallbackPosterUrl = item.image ? (item.image.startsWith('http') ? item.image : `${TVDB_IMAGE_BASE}${item.image}`) : `https://artworks.thetvdb.com/banners/images/missing/series.jpg`;
    const posterUrl = await Utils.getSeriesPoster({ tmdbId: null, tvdbId: tvdbId, metaProvider: 'tvdb', fallbackPosterUrl: fallbackPosterUrl }, config);
    const posterProxyUrl = `${host}/poster/${type}/tvdb:${tvdbId}?fallback=${encodeURIComponent(posterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
    return {
      id: `tvdb:${tvdbId}`,
      type: type,
      name: item.name,
      poster: posterProxyUrl,
      year: item.year || null,
      runtime: Utils.parseRunTime(item.runtime),
      releaseInfo: item.year || null,
    };
  }).filter(Boolean));

  return metas;
}

async function getTmdbAndMdbListCatalog(type, id, genre, page, language, config, catalogChoices) {
  if (id.startsWith("mdblist.")) {
    console.log(`[getCatalog] Fetching MDBList catalog: ${id}, Genre: ${genre}, Page: ${page}`);
    const listId = id.split(".")[1];
    const results = await fetchMDBListItems(listId, config.apiKeys?.mdblist, language, page);
    return await parseMDBListItems(results, type, genre, language, config);
  }

  const genreList = await getGenreList('tmdb', language, type, config);
  const parameters = await buildParameters(type, language, page, id, genre, genreList, config);

  const fetchFunction = type === "movie" 
    ? () => moviedb.discoverMovie(parameters, config) 
    : () => moviedb.discoverTv(parameters, config);

  const res = await fetchFunction();
  const metas = await Promise.all(res.results.map(async item => {
    // Resolve IDs for each individual item
    const allIds = await resolveAllIds(`tmdb:${item.id}`, type, config);
    
    const tmdbPosterFullUrl = item.poster_path
            ? `${TMDB_IMAGE_BASE}${item.poster_path}`
            : `https://artworks.thetvdb.com/banners/images/missing/series.jpg`; 
    const posterUrl = await Utils.getSeriesPoster({ tmdbId: item.id, tvdbId: null, metaProvider: 'tmdb', fallbackPosterUrl: tmdbPosterFullUrl }, config);

    const posterProxyUrl = `${host}/poster/${type}/tmdb:${item.id}?fallback=${encodeURIComponent(posterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
    return {
      id: `tmdb:${item.id}`,
      type: type,
      imdb_id: allIds.imdbId,
      releaseInfo: (item.release_date || item.first_air_date || '').substring(0, 4),
      name: item.title || item.name,
      poster: posterProxyUrl,
      year: (item.release_date || item.first_air_date || '').substring(0, 4),
      background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
      description: item.overview,
      genres: item.genre_ids.map(g => genreList.find(genre => genre.id === g)?.name)
    };
  }));

  return metas;
}

async function buildParameters(type, language, page, id, genre, genreList, config) {
  const languages = await getLanguages(config);
  const parameters = { language, page, 'vote_count.gte': 10 };

  if (id === 'tmdb.top' && type === 'series') {
    console.log('[TMDB Filter] Applying genre exclusion for popular series catalog.');

    const excludedGenreIds = [
      '10767', // Talk
      '10763', // News
      '10768', // War & Politics
    ];
    
    parameters.without_genres = excludedGenreIds.join(',');
    
    console.log(`[TMDB Filter] Excluding genre IDs: ${parameters.without_genres}`);
  }

  if (config.ageRating) {
    switch (config.ageRating) {
      case "G":
        parameters.certification_country = "US";
        parameters.certification = type === "movie" ? "G" : "TV-G";
        break;
      case "PG":
        parameters.certification_country = "US";
        parameters.certification = type === "movie" ? ["G", "PG"].join("|") : ["TV-G", "TV-PG"].join("|");
        break;
      case "PG-13":
        parameters.certification_country = "US";
        parameters.certification = type === "movie" ? ["G", "PG", "PG-13"].join("|") : ["TV-G", "TV-PG", "TV-14"].join("|");
        break;
      case "R":
        parameters.certification_country = "US";
        parameters.certification = type === "movie" ? ["G", "PG", "PG-13", "R"].join("|") : ["TV-G", "TV-PG", "TV-14", "TV-MA"].join("|");
        break;
      case "NC-17":
        break;
    }
  }

  if (id.includes("streaming")) {
    const provider = findProvider(id.split(".")[1]);

    parameters.with_genres = genre ? findGenreId(genre, genreList) : undefined;
    parameters.with_watch_providers = provider.watchProviderId
    parameters.watch_region = provider.country;
    parameters.with_watch_monetization_types = "flatrate|free|ads";
  } else {
    switch (id) {
      case "tmdb.top":
        parameters.sort_by = 'popularity.desc'
        parameters.with_genres = genre ? findGenreId(genre, genreList) : undefined;
        if (type === "series") {
          parameters.watch_region = language.split("-")[1];
          parameters.with_watch_monetization_types = "flatrate|free|ads|rent|buy";
        }
        break;
      case "tmdb.year":
        const year = genre ? genre : new Date().getFullYear();
        parameters[type === "movie" ? "primary_release_year" : "first_air_date_year"] = year;
        break;
      case "tmdb.language":
        const findGenre = genre ? findLanguageCode(genre, languages) : language.split("-")[0];
        parameters.with_original_language = findGenre;
        break;
      default:
        break;
    }
  }
  return parameters;
}

function findGenreId(genreName, genreList) {
  const genreData = genreList.find(genre => genre.name === genreName);
  return genreData ? genreData.id : undefined;
}

function findLanguageCode(genre, languages) {
  const language = languages.find((lang) => lang.name === genre);
  return language ? language.iso_639_1.split("-")[0] : "";
}

function findProvider(providerId) {
  const provider = CATALOG_TYPES.streaming[providerId];
  if (!provider) throw new Error(`Could not find provider: ${providerId}`);
  return provider;
}




module.exports = { getCatalog };
