const { getImdbRatingString } = require('./imdbRatings.js');

/**
 * Fetches the official IMDb rating for a given IMDb ID from the IMDb dataset cache.
 * 
 * @param {string} imdbId - The IMDb ID of the movie or series (e.g., 'tt0133093').
 * @returns {Promise<string|undefined>} The IMDb rating as a string (e.g., "8.7") or undefined if not found or on error.
 */
async function getImdbRating(imdbId) {
  if (!imdbId) {
    return undefined;
  }

  return await getImdbRatingString(imdbId);
}

module.exports = { getImdbRating };
