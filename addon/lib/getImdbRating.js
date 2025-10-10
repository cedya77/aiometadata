const { getImdbRatingString } = require('./imdbRatings.js');

/**
 * Fetches the official IMDb rating for a given IMDb ID from the IMDb dataset cache.
 * Falls back to Cinemeta if not found in dataset.
 * 
 * @param {string} imdbId - The IMDb ID of the movie or series (e.g., 'tt0133093').
 * @param {'movie'|'series'} type - The content type.
 * @returns {Promise<string|undefined>} The IMDb rating as a string (e.g., "8.7") or undefined if not found or on error.
 */
async function getImdbRating(imdbId, type) {
  if (!imdbId) {
    return undefined;
  }

  return await getImdbRatingString(imdbId, type);
}

module.exports = { getImdbRating };
