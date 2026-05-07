const { getImdbRatingString }: any = require('./imdbRatings');

async function getImdbRating(imdbId: string): Promise<string | undefined> {
  if (!imdbId) {
    return undefined;
  }

  return await getImdbRatingString(imdbId);
}

export { getImdbRating };
module.exports = { getImdbRating };
