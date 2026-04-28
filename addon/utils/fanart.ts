require("dotenv").config();
const FanartTvApi = require('@fanart-tv/api');
import { LRUCache } from 'lru-cache';
const { cacheWrapGlobal } = require('../lib/getCache');
const FANART_IMAGE_BASE = 'https://assets.fanart.tv/fanart/movies/';

const clientCache = new LRUCache<string, any>({
  max: parseInt(process.env.FANART_CLIENT_CACHE_MAX as string, 10) || 2000,
  ttl: 24 * 60 * 60 * 1000,
});

function getFanartClient(config: any): any | null {
  const projectKey = process.env.FANART_API_PROJECT_KEY || process.env.FANART_API_KEY;
  const personalKey = config.apiKeys?.fanart;
  const apiKey = projectKey || personalKey;
  if (!apiKey) {
    return null;
  }

  const cacheKey = `${apiKey}:${personalKey || ''}`;
  if (clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey);
  }

  try {
    const opts: any = { apiKey, version: 'v3.2' };
    if (projectKey && personalKey) {
      opts.clientKey = personalKey;
    }
    const newClient = new FanartTvApi(opts);

    clientCache.set(cacheKey, newClient);
    return newClient;
  } catch (error: any) {
    console.error(`[Fanart] Failed to initialize client:`, error.message);
    return null;
  }
}

async function getBestSeriesBackground(tvdbId: string, config: any): Promise<string | null> {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tvdbId) {
    return null;
  }

  const cacheKey = `fanart-api:series-background:${tvdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getShowImages(tvdbId);

      if (!images.showbackground || images.showbackground.length === 0) {
        return null;
      }
      const selectedBackground = selectFanartImageByLang(images.showbackground, config, 'lang');
      const backgroundUrl = selectedBackground.url.startsWith('http') ? selectedBackground.url : `${FANART_IMAGE_BASE}${selectedBackground.id}/showbackground/${selectedBackground.url}`;
      return backgroundUrl;
    } catch (error: any) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TVDB ID ${tvdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TVDB ID ${tvdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60);
}

async function getBestMovieBackground(tmdbId: string, config: any): Promise<string | null> {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

  const cacheKey = `fanart-api:movie-background:${tmdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getMovieImages(tmdbId);
      if (!images.moviebackground || images.moviebackground.length === 0) {
        return null;
      }
      const selectedBackground = selectFanartImageByLang(images.moviebackground, config, 'lang');
      const backgroundUrl = selectedBackground.url.startsWith('http') ? selectedBackground.url : `${FANART_IMAGE_BASE}${selectedBackground.id}/moviebackground/${selectedBackground.url}`;
      return backgroundUrl;
    } catch (error: any) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TMDB ID ${tmdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TMDB ID ${tmdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60);
}

async function getMovieImages(tmdbId: string, config: any): Promise<any | null> {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

  const cacheKey = `fanart-api:movie-images:${tmdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      return await fanartClient.getMovieImages(tmdbId);
    } catch (error: any) {
      if (error.message && !error.message.includes("Not Found")) {
        console.error(`[Fanart] Error in getMovieImages for TMDB ID ${tmdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60);
}

async function getBestMoviePoster(tmdbId: string, config: any): Promise<string | null> {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

  const cacheKey = `fanart-api:movie-poster:${tmdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getMovieImages(tmdbId);
      if (!images.movieposter || images.movieposter.length === 0) {
        return null;
      }
      const selectedPoster = selectFanartImageByLang(images.movieposter, config, 'lang');
      const posterUrl = selectedPoster.url.startsWith('http') ? selectedPoster.url : `${FANART_IMAGE_BASE}${selectedPoster.id}/movieposter/${selectedPoster.url}`;
      return posterUrl;
    } catch (error: any) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TMDB ID ${tmdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TMDB ID ${tmdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60);
}

async function getBestMovieLogo(tmdbId: string, config: any): Promise<string | null> {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tmdbId) {
    return null;
  }

  const cacheKey = `fanart-api:movie-logo:${tmdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getMovieImages(tmdbId);
      if (!images.hdmovielogo || images.hdmovielogo.length === 0) {
        return null;
      }
      const selectedLogo = selectFanartImageByLang(images.hdmovielogo, config, 'lang');
      const logoUrl = selectedLogo.url.startsWith('http') ? selectedLogo.url : `${FANART_IMAGE_BASE}${selectedLogo.id}/hdmovielogo/${selectedLogo.url}`;
      return logoUrl;
    } catch (error: any) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TMDB ID ${tmdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TMDB ID ${tmdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60);
}

async function getBestSeriesPoster(tvdbId: string, config: any): Promise<string | null> {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tvdbId) {
    return null;
  }

  const cacheKey = `fanart-api:series-poster:${tvdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getShowImages(tvdbId);
      if (!images.tvposter || images.tvposter.length === 0) {
        return null;
      }
      const selectedPoster = selectFanartImageByLang(images.tvposter, config, 'lang');
      const posterUrl = selectedPoster.url.startsWith('http') ? selectedPoster.url : `${FANART_IMAGE_BASE}${selectedPoster.id}/tvposter/${selectedPoster.url}`;
      return posterUrl;
    } catch (error: any) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TVDB ID ${tvdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TVDB ID ${tvdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60);
}

async function getBestTVLogo(tvdbId: string, config: any): Promise<string | null> {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tvdbId) {
    return null;
  }

  const cacheKey = `fanart-api:series-logo:${tvdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      const images = await fanartClient.getShowImages(tvdbId);
      if (!images.hdtvlogo || images.hdtvlogo.length === 0) {
        return null;
      }
      const selectedLogo = selectFanartImageByLang(images.hdtvlogo, config, 'lang');
      const logoUrl = selectedLogo.url.startsWith('http') ? selectedLogo.url : `${FANART_IMAGE_BASE}${selectedLogo.id}/hdtvlogo/${selectedLogo.url}`;
      return logoUrl;
    } catch (error: any) {
      if (error.message && error.message.includes("Not Found")) {
        console.log(`[Fanart] No entry found on Fanart.tv for TVDB ID ${tvdbId}.`);
      } else {
        console.error(`[Fanart] Error fetching data for TVDB ID ${tvdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60);
}

async function getShowImages(tvdbId: string, config: any): Promise<any | null> {
  const fanartClient = getFanartClient(config);
  if (!fanartClient || !tvdbId) {
    return null;
  }

  const cacheKey = `fanart-api:series-images:${tvdbId}`;
  return cacheWrapGlobal(cacheKey, async () => {
    try {
      return await fanartClient.getShowImages(tvdbId);
    } catch (error: any) {
      if (error.message && !error.message.includes("Not Found")) {
        console.error(`[Fanart] Error in getShowImages for TVDB ID ${tvdbId}:`, error.message);
      }
      return null;
    }
  }, 7 * 24 * 60 * 60);
}

interface FanartImage {
  url: string;
  id: string;
  likes: string;
  [key: string]: string;
}

function selectFanartImageByLang(images: FanartImage[], config: any, key: string = 'lang'): FanartImage | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;

  const targetLang = config.artProviders?.englishArtOnly ? 'en' : (config.language?.split('-')[0]?.toLowerCase() || 'en');

  let filtered = images.filter(img => img[key] === targetLang);
  if (filtered.length === 0) filtered = images.filter(img => img[key] === 'en');
  if (filtered.length === 0) filtered = images.filter(img => img[key] === '00');
  if (filtered.length === 0) filtered = images;
  filtered.sort((a, b) => parseInt(b.likes || '0') - parseInt(a.likes || '0'));
  return filtered[0];
}


module.exports = {
  getBestSeriesBackground,
  getBestMovieBackground,
  getBestSeriesPoster,
  getBestMoviePoster,
  getMovieImages,
  getShowImages,
  getBestMovieLogo,
  getBestTVLogo,
  selectFanartImageByLang,
  getMemoryStats: () => ({ clientCache: clientCache.size }),
};
