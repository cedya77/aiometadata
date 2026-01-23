// lib/getGenreList.js

require('dotenv').config();
const moviedb = require("./getTmdb");
const { getAllGenres } = require('./tvdb');
const { cacheWrapGlobal } = require('./getCache');

/**
 * Fetches a list of genres from TMDB/TVDB for building catalogs.
 * Uses caching since genre lists rarely change and are called frequently.
 *
 * @param {string} catalogType - The catalog type ('tmdb' or 'tvdb').
 * @param {string} language - The language for the genre names (e.g., 'en-US').
 * @param {'movie'|'series'} type - The content type to fetch genres for.
 * @param {object} config - Configuration object.
 * @returns {Promise<Array<{id: number, name: string}>>} A list of genre objects, or an empty array on error.
 */
async function getGenreList(catalogType, language, type, config) {
  // Cache key that will be detected as 'genre' content type for validation
  const cacheKey = `genre:${catalogType}:${language}:${type}`;
  
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      if (catalogType === 'tmdb') {
        if (type === "movie") {
          const res = await moviedb.genreMovieList({ language }, config);
          return res.genres || []; 
        } else {
          const res = await moviedb.genreTvList({ language }, config);
          return res.genres || [];
        }
      } else if (catalogType === 'tvdb') {
        const genres = await getAllGenres(config);
        return genres || [];
      }
    } catch (error) {
      console.error(`Error fetching ${type} genres from ${catalogType}:`, error.message);
      return [];
    }
  }, 30 * 24 * 60 * 60, { skipVersion: true });
}

module.exports = { getGenreList };
