const tvdbToTMDBMap = {
  'science fiction': { movie: 'Science Fiction', series: 'Sci-Fi & Fantasy' },
  'fantasy': { movie: 'Fantasy', series: 'Sci-Fi & Fantasy' },
  'war': { movie: 'War', series: 'War & Politics' },
  'action': { movie: 'Action', series: 'Action & Adventure' },
  'adventure': { movie: 'Adventure', series: 'Action & Adventure' },
  'children': { movie: 'Family', series: 'Kids' },

  'talk show': 'Talk',
  'anime': 'Animation',
  'suspense': 'Thriller', // Map "Suspense" to the more standard "Thriller"
  'martial arts': 'Action', // Map "Martial Arts" into the broader "Action"
  'musical': 'Music',
  'soap': 'Soap', 

  'home and garden': 'Reality',
  'food': 'Reality',
  'game show': 'Reality',

  'mini-series': null,
  'sport': null,
  'travel': null,
  'podcast': null,
  'awards show': null,
  'indie': null,
};

/**
 * Converts an array of genre objects from TheTVDB to an array of genre strings
 * that are valid for Cinemeta/Stremio, based on the media type.
 * 
 * @param {Array<{name: string}>} tvdbGenres - An array of genre objects from TVDB.
 * @param {'movie' | 'series'} mediaType - The type of content, to resolve ambiguous mappings.
 * @returns {Array<string>} An array of converted and validated genre strings.
 */
function convertTvdbToCinemetaGenres(tvdbGenres, mediaType) {
  if (!Array.isArray(tvdbGenres)) return [];

  const convertedGenres = new Set(); // Use a Set to avoid duplicates

  for (const tvdbGenre of tvdbGenres) {
    if (!tvdbGenre || !tvdbGenre.name) continue;

    const lowerTvdbGenre = tvdbGenre.name.toLowerCase();
    
    if (Object.prototype.hasOwnProperty.call(tvdbToTMDBMap, lowerTvdbGenre)) {
      const mapping = tvdbToTMDBMap[lowerTvdbGenre];

      if (mapping === null) {
        continue;
      } else if (typeof mapping === 'object') {
        convertedGenres.add(mapping[mediaType]);
      } else {
        convertedGenres.add(mapping);
      }
    } else {
      const formattedGenre = tvdbGenre.name.replace(/\b\w/g, char => char.toUpperCase());
      convertedGenres.add(formattedGenre);
    }
  }

  return Array.from(convertedGenres).filter(Boolean); // Filter out any potential nulls/undefined
}

module.exports = { convertTvdbToCinemetaGenres };
