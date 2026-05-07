require("dotenv").config();
const moviedb: any = require("./getTmdb");
const translations: any = require("../static/translations.json");
const { getMeta }: any = require("./getMeta");
const { cacheWrapMetaSmart }: any = require("./getCache");


function getAllTranslations(key: string): string[] {
    return Object.values(translations).map((lang: any) => lang[key]).filter(Boolean);
}

const API_FIELD_MAPPING: Record<string, string> = {
    'added_date': 'created_at',
    'popularity': 'popularity',
    'release_date': 'release_date'
};

function sortResults(results: any[], genre: string): any[] {
    if (!genre) return results;

    let sortedResults = [...results];

    const randomTranslations = getAllTranslations('random');
    if (randomTranslations.includes(genre)) {
        return shuffleArray(sortedResults);
    }

    let field: string | undefined, order: string | undefined;

    const fields: Record<string, string[]> = {
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

    sortedResults.sort((a: any, b: any) => {
        let valueA: any, valueB: any;

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

function configureSortingParameters(parameters: any, genre: string): any {
    const fields: Record<string, string[]> = {
        'added_date': getAllTranslations('added_date'),
        'popularity': getAllTranslations('popularity'),
        'release_date': getAllTranslations('release_date')
    };

    for (const [fieldName, translations] of Object.entries(fields)) {
        if (genre?.includes(translations.find(t => genre.includes(t)) as string)) {
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

function shuffleArray(array: any[]): any[] {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}


async function getPersonalList(
    type: string,
    language: string,
    page: number,
    genre: string,
    sessionId: string,
    listType: 'favorite' | 'watchlist',
    config: any,
    userUUID: string,
    includeVideos: boolean = false
): Promise<{ metas: any[] }> {
  if (!sessionId) {
    console.warn(`[TMDB Personal List] Attempted to fetch personal ${listType} without a session ID. User needs to authenticate with TMDB.`);
    return { metas: [] };
  }

  try {
    let parameters: any = { language, page, session_id: sessionId };
    parameters = configureSortingParameters(parameters, genre);

    let fetchFunction: () => Promise<any>;
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

    const metas = await Promise.all(sortedResults.map(async (item: any) => {
      const stremioId = `tmdb:${item.id}`;

      const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
        return await getMeta(type, language, stremioId, config, userUUID, includeVideos);
      }, undefined, {enableErrorCaching: true, maxRetries: 2, config}, type, includeVideos);

      if (result && result.meta) {
        return result.meta;
      }
      return null;
    }));

    const validMetas = metas.filter((meta: any) => meta !== null);

    return { metas: validMetas };

  } catch (error: any) {
    console.error(`[TMDB Personal List] Error fetching personal ${listType} for ${type}:`, error.message);
    if (error.response) {
      console.error(`[TMDB Personal List] Error response:`, error.response.data);
      console.error(`[TMDB Personal List] Error status:`, error.response.status);
    }
    return { metas: [] };
  }
}


async function getFavorites(type: string, language: string, page: number, genre: string, sessionId: string, config: any, userUUID: string, includeVideos: boolean = false): Promise<{ metas: any[] }> {
  return getPersonalList(type, language, page, genre, sessionId, 'favorite', config, userUUID, includeVideos);
}

async function getWatchList(type: string, language: string, page: number, genre: string, sessionId: string, config: any, userUUID: string, includeVideos: boolean = false): Promise<{ metas: any[] }> {
  return getPersonalList(type, language, page, genre, sessionId, 'watchlist', config, userUUID, includeVideos);
}


export { getFavorites, getWatchList };
module.exports = { getFavorites, getWatchList };
