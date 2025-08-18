const axios = require('axios');


async function getMetaFromImdb(imdbId, type) {
    if (!imdbId) {
      return undefined;
    }
  
    const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
    try {
      const response = await axios.get(url);
      return response.data?.meta;
  
    } catch (error) {
      console.warn(`Could not fetch meta for ${imdbId} from Cinemeta for type ${type}. Error: ${error.message}`);
      return undefined;
    }
  }

  module.exports = { getMetaFromImdb };