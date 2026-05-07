require('dotenv').config();
const moviedb: any = require("./getTmdb");
const { getAllGenres }: any = require('./tvdb');
const { cacheWrapGlobal }: any = require('./getCache');

async function getGenreList(catalogType: string, language: string, type: string, config: any): Promise<Array<{ id: number; name: string }>> {
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
    } catch (error: any) {
      console.error(`Error fetching ${type} genres from ${catalogType}:`, error.message);
      return [];
    }
  }, 30 * 24 * 60 * 60, { skipVersion: true });
}

export { getGenreList };
module.exports = { getGenreList };
