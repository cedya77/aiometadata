// --- Import your provider clients ---
// These are the modules that actually make the API calls.
const tmdb = require('../lib/getTmdb');
const fanart = require('./fanart'); // Assuming a Fanart.tv client
const tvdb = require('../lib/tvdb');     // Assuming a TVDB client
const imdb = require('../lib/imdb');     // Assuming an IMDb client for art
const tvmaze = require('../lib/tvmaze'); // Assuming a TVMaze client

// =================================================================
// SECTION 1: Provider Resolution Logic
// =================================================================

/**
 * Returns the hardcoded default metadata provider for a given content type.
 * This is the final fallback if no user configuration is present.
 *
 * @param {string} contentType - The type of content ('movie', 'series', 'anime').
 * @returns {string} The default provider name (e.g., 'tmdb', 'tvdb').
 */
function getDefaultProvider(contentType) {
  switch (contentType) {
    case 'anime': return 'mal';
    case 'movie': return 'tmdb';
    case 'series': return 'tvdb';
    default: return 'tmdb';
  }
}

/**
 * Resolves the art provider for a given content and art type based on user configuration.
 * It supports both a legacy string format and a modern object format for art provider settings.
 *
 * @param {string} contentType - The type of content (e.g., 'movie', 'series').
 * @param {string} artType - The type of art (e.g., 'poster', 'logo', 'background').
 * @param {object} config - The user's full configuration object.
 * @returns {string} The name of the provider to use for the art (e.g., 'tmdb', 'fanart').
 */
function resolveArtProvider(contentType, artType, config) {
  // Determine the ultimate fallback provider ONCE at the beginning.
  // This is the value to use if a specific art provider isn't set, or is set to 'meta'.
  const fallbackProvider = config.providers?.[contentType] || getDefaultProvider(contentType);

  const artProviderConfig = config.artProviders?.[contentType];

  // Handle the new, more specific object format.
  if (typeof artProviderConfig === 'object' && artProviderConfig !== null) {
    const specificProvider = artProviderConfig[artType];
    return (specificProvider && specificProvider !== 'meta') ? specificProvider : fallbackProvider;
  }

  // Handle the legacy string format.
  if (typeof artProviderConfig === 'string') {
    return (artProviderConfig && artProviderConfig !== 'meta') ? artProviderConfig : fallbackProvider;
  }

  // If no artProviderConfig exists at all, return the ultimate fallback.
  return fallbackProvider;
}


// =================================================================
// SECTION 2: Art Fetching and Selection Logic
// =================================================================

/**
 * Intelligently fetches art from multiple providers based on user config
 * and selects the final URLs for poster, background, and logo.
 *
 * @param {string} mediaType - 'movie' or 'series'.
 * @param {object} allIds - An object with all resolved IDs (tmdbId, tvdbId, imdbId).
 * @param {object} config - The user's configuration object.
 * @returns {Promise<{posterUrl: string|null, backgroundUrl: string|null, logoUrl: string|null}>}
 */
async function fetchAndSelectArt(mediaType, allIds, config) {
  const { tmdbId, tvdbId, imdbId, tvmazeId } = allIds;

  // STEP 1: Use resolveArtProvider to determine the plan for each art type.
  const posterProvider = resolveArtProvider(mediaType, 'poster', config);
  const backgroundProvider = resolveArtProvider(mediaType, 'background', config);
  const logoProvider = resolveArtProvider(mediaType, 'logo', config);

  // STEP 2: Figure out which unique APIs we need to call.
  const providersToCall = new Set();
  providersToCall.add(posterProvider);
  providersToCall.add(backgroundProvider);
  providersToCall.add(logoProvider);

  const apiPromises = {};

  // We always fetch TMDB images as it's the most common and reliable fallback.
  if (tmdbId) {
    apiPromises.tmdb = tmdb.getTmdbImages(mediaType, tmdbId, config);
  }

  if (providersToCall.has('fanart') && (allIds.tmdbId || allIds.tvdbId)) {
    apiPromises.fanart = fanart.getImages(allIds, config); 
  }
  if (providersToCall.has('tvdb') && tvdbId) {
    apiPromises.tvdb = tvdb.getImages(mediaType, allIds.tvdbId, config); 
  }
  if (providersToCall.has('imdb') && imdbId) {
    apiPromises.imdb = imdb.getArt(imdbId);
  }
  if (providersToCall.has('tvmaze') && tvmazeId) {
    apiPromises.tvmaze = tvmaze.getImages(tvmazeId, config);
  }

  // STEP 3: Execute all necessary API calls in parallel.
  const fetchedData = {};
  const results = await Promise.allSettled(Object.values(apiPromises));
  Object.keys(apiPromises).forEach((key, index) => {
    if (results[index].status === 'fulfilled') {
      fetchedData[key] = results[index].value;
    } else {
      console.warn(`[Art Fetcher] Failed to fetch data from ${key}:`, results[index].reason?.message || results[index].reason);
      fetchedData[key] = null;
    }
  });

  const { tmdb: tmdbImages, fanart: fanartImages, tvdb: tvdbData, imdb: imdbArt } = fetchedData;

  // STEP 4: Select the final art URL for each type based on preference and availability.
  const select = (type, provider) => {
    switch (provider) {
        case 'fanart':
            if (!fanartImages) return null;
            
            // This is where the logic from the old getBest... functions now lives.
            let imageArray;
            if (mediaType === 'movie') {
              if (type === 'logo') imageArray = fanartImages.hdmovielogo;
              else if (type === 'poster') imageArray = fanartImages.movieposter;
              else if (type === 'background') imageArray = fanartImages.moviebackground;
            } else { // series
              if (type === 'logo') imageArray = fanartImages.hdtvlogo;
              else if (type === 'poster') imageArray = fanartImages.tvposter;
              else if (type === 'background') imageArray = fanartImages.showbackground;
            }
            
            const bestImage = fanart.selectFanartImageByLang(imageArray, config);
            return bestImage ? bestImage.url : null;
      case 'tvdb':
        if (!tvdbData || !tvdbData.artworks) return null;
        
        let artwork;
        // This is where the logic from the old get... functions now lives.
        if (mediaType === 'movie') {
            if (type === 'logo') artwork = tvdbData.artworks.find(art => art.type === 25);
            else if (type === 'poster') return tvdbData.image; // Main poster is not in artworks
            else if (type === 'background') artwork = tvdbData.artworks.find(art => art.type === 15 || art.type === 3);
        } else { // series
            if (type === 'logo') artwork = tvdbData.artworks.find(art => art.type === 23);
            else if (type === 'poster') return tvdbData.image;
            else if (type === 'background') artwork = tvdbData.artworks.find(art => art.type === 3);
        }
        
        // Return the full URL if an artwork was found
        return artwork?.image ? artwork.image : null;
      case 'imdb':
        if (!imdbArt) return null;
        if (type === 'logo' && imdbArt.logo) return imdbArt.logo;
      case 'tvmaze':
        if (!tvmazeImages) return null;
        const tvmazeImageTypeKey = type === 'background' ? 'backdrops' : type + 's'; // posters, logos
        const tvmazeSelectedImage = tvmaze.selectTvmazeImageByLang(tvmazeImages[tvmazeImageTypeKey], config);
        return tvmazeSelectedImage ? tvmazeSelectedImage.url : null;
      case 'tmdb':
        if (!tmdbImages) return null;
        const imageTypeKey = type === 'background' ? 'backdrops' : type + 's'; // posters, logos
        const selectedImage = tmdb.selectTmdbImageByLang(tmdbImages[imageTypeKey], config);
        return selectedImage ? `https://image.tmdb.org/t/p/original${selectedImage.file_path}` : null;
    }
    return null;
  };
  
  // Try preferred provider first, then fall back to TMDB.
  const posterUrl = select('poster', posterProvider) || select('poster', 'tmdb');
  const backgroundUrl = select('background', backgroundProvider) || select('background', 'tmdb');
  const logoUrl = select('logo', logoProvider) || select('logo', 'tmdb');

  return { posterUrl, backgroundUrl, logoUrl };
}

module.exports = {
  resolveArtProvider,
  fetchAndSelectArt
};