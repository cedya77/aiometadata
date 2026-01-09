require("dotenv").config();
const moviedb = require("./getTmdb");
const { getGenreList } = require("./getGenreList");
const { parseMedia } = require("../utils/parseProps");
const translations = require("../static/translations.json");
const { getMeta } = require("./getMeta");
const { cacheWrapMetaSmart } = require("./getCache");


function getAllTranslations(key) {
    return Object.values(translations).map(lang => lang[key]).filter(Boolean);
}

const API_FIELD_MAPPING = {
    'added_date': 'created_at',
    'popularity': 'popularity',
    'release_date': 'release_date'
};

function sortResults(results, genre) {
    if (!genre) return results;

    let sortedResults = [...results];
    
    const randomTranslations = getAllTranslations('random');
    if (randomTranslations.includes(genre)) {
        return shuffleArray(sortedResults);
    }

    let field, order;
    
    const fields = {
        'added_date': getAllTranslations('added_date'),
        'popularity': getAllTranslations('popularity'),
        'release_date': getAllTranslations('release_date')
    };

    for (const [fieldName, translations] of Object.entries(fields)) {
        if (translations.some(t => genre.includes(t))) {
            field = fieldName;
            break;
        }
    }

    if (!field) return sortedResults;

    const ascTranslations = getAllTranslations('asc');
    const descTranslations = getAllTranslations('desc');

    if (ascTranslations.some(t => genre.includes(t))) {
        order = 'asc';
    } else if (descTranslations.some(t => genre.includes(t))) {
        order = 'desc';
    } else {
        return sortedResults;
    }

    sortedResults.sort((a, b) => {
        let valueA, valueB;
        
        switch (field) {
            case 'release_date':
                valueA = a.release_date || a.first_air_date;
                valueB = b.release_date || b.first_air_date;
                break;
            case 'popularity':
                valueA = a.popularity;
                valueB = b.popularity;
                break;
            case 'added_date':
            default:
                return 0;
        }

        if (order === 'asc') {
            return valueA < valueB ? -1 : 1;
        }
        return valueA > valueB ? -1 : 1;
    });

    return sortedResults;
}

function configureSortingParameters(parameters, genre) {
    const fields = {
        'added_date': getAllTranslations('added_date'),
        'popularity': getAllTranslations('popularity'),
        'release_date': getAllTranslations('release_date')
    };

    for (const [fieldName, translations] of Object.entries(fields)) {
        if (genre?.includes(translations.find(t => genre.includes(t)))) {
            const ascTranslations = getAllTranslations('asc');
            const descTranslations = getAllTranslations('desc');
            
            if (ascTranslations.some(t => genre.includes(t))) {
                parameters.sort_by = `${API_FIELD_MAPPING[fieldName]}.asc`;
            } else if (descTranslations.some(t => genre.includes(t))) {
                parameters.sort_by = `${API_FIELD_MAPPING[fieldName]}.desc`;
            }
            break;
        }
    }
    return parameters;
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}



/**
 * A generic worker function to fetch a personal list (Favorites or Watchlist) from TMDB.
 * @param {'movie'|'series'} type - The content type.
 * @param {string} language - The user's language.
 * @param {number} page - The page number to fetch.
 * @param {string} genre - The genre/sorting string.
 * @param {string} sessionId - The user's TMDB session ID.
 * @param {'favorite'|'watchlist'} listType - The type of list to fetch.
 * @param {object} config - The user configuration.
 * @param {string} userUUID - The user's UUID for caching.
 * @param {boolean} includeVideos - Whether to include videos.
 * @returns {Promise<{metas: Array}>} A Stremio catalog object.
 */
async function getPersonalList(type, language, page, genre, sessionId, listType, config, userUUID, includeVideos = false) {
  if (!sessionId) {
    console.warn(`[TMDB Personal List] Attempted to fetch personal ${listType} without a session ID. User needs to authenticate with TMDB.`);
    return { metas: [] };
  }

  try {
    let parameters = { language, page, session_id: sessionId };
    parameters = configureSortingParameters(parameters, genre);

    let fetchFunction;
    if (listType === 'favorite') {
      fetchFunction =  type === "movie" 
      ? () => moviedb.accountFavoriteMovies(parameters, config) 
      : () => moviedb.accountFavoriteTv(parameters, config);
    } else { 
      fetchFunction = type === "movie" 
      ? () => moviedb.accountMovieWatchlist(parameters, config) 
      : () => moviedb.accountTvWatchlist(parameters, config);
    }

    const res = await fetchFunction();

    const sortedResults = sortResults(res?.results || [], genre);
    
    // Call getMeta for each item to get full metadata (similar to getCatalog)
    const metas = await Promise.all(sortedResults.map(async (item) => {
      const stremioId = `tmdb:${item.id}`;
      
      const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
        return await getMeta(type, language, stremioId, config, userUUID, includeVideos);
      }, undefined, {enableErrorCaching: true, maxRetries: 2}, type, includeVideos);
      
      if (result && result.meta) {
        return result.meta;
      }
      return null;
    }));

    const validMetas = metas.filter(meta => meta !== null);

    return { metas: validMetas };

  } catch (error) {
    console.error(`[TMDB Personal List] Error fetching personal ${listType} for ${type}:`, error.message);
    if (error.response) {
      console.error(`[TMDB Personal List] Error response:`, error.response.data);
      console.error(`[TMDB Personal List] Error status:`, error.response.status);
    }
    return { metas: [] };
  }
}



async function getFavorites(type, language, page, genre, sessionId, config, userUUID, includeVideos = false) {
  return getPersonalList(type, language, page, genre, sessionId, 'favorite', config, userUUID, includeVideos);
}

async function getWatchList(type, language, page, genre, sessionId, config, userUUID, includeVideos = false) {
  return getPersonalList(type, language, page, genre, sessionId, 'watchlist', config, userUUID, includeVideos);
}


module.exports = { getFavorites, getWatchList };
