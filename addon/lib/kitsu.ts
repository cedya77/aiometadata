import Kitsu from 'kitsu';
import axios, { AxiosResponse } from 'axios';
import { cacheWrapGlobal } from './getCache.js';
import consola from 'consola';

const logger = consola.withTag('Kitsu');

// Initialize Kitsu client
const kitsu = new Kitsu();

const normalizeToFlat = (item: any): any => {
  if (!item.attributes) {
      return item; // already flat
  }
  const { attributes, ...rest } = item;
  return { ...rest, ...attributes };
};

// Type definitions for Kitsu API responses
export interface KitsuAnimeAttributes {
  canonicalTitle: string;
  titles: {
    en_us?: string;
    en_jp?: string;
    en?: string;
    ja_jp?: string;
  };
  synopsis: string;
  description: string;
  subtype: string;
  status: string;
  startDate: string;
  endDate: string;
  episodeCount: number;
  episodeLength: number;
  totalLength: number;
  ageRating: string;
  ageRatingGuide: string;
  showType: string;
  nsfw: boolean;
  createdAt: string;
  updatedAt: string;
  slug: string;
  youtubeVideoId: string;
  coverImage: {
    tiny: string;
    small: string;
    large: string;
    original: string;
  } | null;
  posterImage: {
    tiny: string;
    small: string;
    medium: string;
    large: string;
    original: string;
  } | null;
  bannerImage: {
    tiny: string;
    small: string;
    large: string;
    original: string;
  } | null;
}

export interface KitsuAnime {

  id: string;

  type: string;

  attributes?: KitsuAnimeAttributes;

  relationships?: {

    episodes: {

      data: Array<{

        id: string;

        type: string;

      }>;

    };

    genres: {

      data: Array<{

        id: string;

        type: string;

      }>;

    };

    mediaRelationships: {

      data: Array<{

        id: string;

        type: string;

      }>;

    };

  };

  [key: string]: any;

}

export interface KitsuEpisodeAttributes {
  number: number;
  seasonNumber: number;
  relativeNumber: number;
  title: string;
  synopsis: string;
  airdate: string;
  length: number;
  thumbnail: {
    tiny: string;
    small: string;
    medium: string;
    large: string;
    original: string;
  } | null;
  canonicalTitle: string;
  createdAt: string;
  updatedAt: string;
}

export interface KitsuEpisode {
  id: string;
  type: string;
  attributes: KitsuEpisodeAttributes;
}

interface KitsuApiResponse<T> {
  data: T[];
  links?: {
    first?: string;
    next?: string;
    last?: string;
  };
  meta?: {
    count: number;
  };
}

interface KitsuDirectApiResponse {
  data: KitsuAnime[];
  included?: any[];
  links?: {
    first?: string;
    next?: string;
    last?: string;
  };
  meta?: {
    count: number;
  };
}

/**
 * Searches Kitsu for anime by a text query.
 * @param query - The name of the anime to search for.
 * @returns A promise that resolves to an array of Kitsu anime resource objects.
 */
async function searchByName(query: string, subtypes: string[] = [], ageRating: string = 'G'): Promise<KitsuAnime[]> {
  if (!query.trim()) return [];

  const results: KitsuAnime[] = [];
  const startTime = Date.now();

  try {
    // Loop over all provided subtypes
    for (const subtype of subtypes.length ? subtypes : ['tv']) {
      let nextUrl: string | undefined;
      let params: any = {
        'filter[text]': query,
        'filter[subtype]': subtype,
        'page[limit]': 20,
        include: 'genres'
      };
      if(ageRating.toLowerCase() !== 'none') {
        params['filter[ageRating]'] = ageRating;
      }

      // 🔹 Fetch first page for this subtype
      let response = await kitsu.fetch('anime', {
        params: params
      });

      // Add results
      results.push(...(response.data ?? []));
      nextUrl = response.links?.next;

      // 🔁 Paginate until no next page
      while (nextUrl) {
        const nextResponse = await fetch(nextUrl);
        if (!nextResponse.ok) break;

        const nextData = await nextResponse.json() as KitsuApiResponse<KitsuAnime>;
        
        // Manually flatten the attributes for paginated results to match the library's output
        const flattenedData = (nextData.data ?? []).map(item => ({
          id: item.id,
          type: item.type,
          ...item.attributes
        }));

        results.push(...flattenedData);
        nextUrl = nextData.links?.next;
      }
    }

    // Track successful request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, true);

    return results;
  } catch (error: any) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, false);
    
    // Log error to dashboard
    const status = error.response?.status;
    const errorType = status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'api_error';
    requestTracker.logProviderError('kitsu', errorType, `Search failed: ${error.message}`, {
      query,
      status
    });
    
    logger.error(`Error searching for "${query}":`, error.message);
    return results;
  }
}



/**
 * Fetches the full details for multiple anime by their Kitsu IDs with pagination support.
 * @param ids - An array of Kitsu IDs.
 * @returns A promise that resolves to an array of Kitsu anime resource objects.
 */
async function getMultipleAnimeDetails(ids: (string | number)[], appends: string = 'genres') {
  if (!ids || ids.length === 0) {
    return null;
  }
  
  const startTime = Date.now();
  
  try {
    logger.info(`Fetching details for ${ids.length} IDs: ${ids.join(',')}`);
    
    // Use direct API call to bypass Kitsu library filter issues
    const baseUrl = `https://kitsu.io/api/edge/anime?filter[id]=${ids.join(',')}&include=${appends}&page[size]=20`;
    
    logger.debug(`Direct API URL: ${baseUrl}`);
    
    const allData: KitsuAnime[] = [];
    const allIncluded: any[] = [];
    let nextUrl: string | undefined = baseUrl;
    let pageCount = 0;

    // Paginate through all results
    while (nextUrl) {
      pageCount++;
      logger.debug(`Fetching page ${pageCount}...`);
      
      const response: AxiosResponse<KitsuDirectApiResponse> = await axios.get(nextUrl, {
        headers: {
          'Accept': 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json'
        },
        timeout: 10000
      });
      
      const pageData = response.data?.data || [];
      const pageIncluded = response.data?.included || [];
      logger.debug(`Page ${pageCount} received ${pageData.length} results, ${pageIncluded.length} included items`);
      
      allData.push(...pageData);
      allIncluded.push(...pageIncluded);
      
      // Check for next page
      nextUrl = response.data?.links?.next;
      if (nextUrl) {
        logger.debug(`Found next page, continuing pagination...`);
      }
    }

    logger.debug(`Total results after pagination: ${allData.length} data items, ${allIncluded.length} included items across ${pageCount} page(s)`);
    const receivedIds = allData.map(item => item.id);
    logger.success(`Received IDs: ${receivedIds.join(',')}`);
    
    // Track successful request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, true);
    
    return {
      data: allData,
      included: allIncluded,
      meta: { count: allData.length }
    };
    
  } catch (error: any) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, false);
    
    const status = error.response?.status;
    const errorType = status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'api_error';
    requestTracker.logProviderError('kitsu', errorType, `getMultipleAnimeDetails failed: ${error.message}`, {
      ids: ids.slice(0, 5).join(','),
      status
    });
    
    logger.error(`Error fetching details for IDs ${ids.join(',')}:`, (error as Error).message);
    return null;
  }
}

/**
 * Fetches episode data for an anime by its Kitsu ID.
 * @param kitsuId - The Kitsu anime ID.
 * @returns A promise that resolves to an array of episode objects.
 */
async function getAnimeEpisodes(kitsuId: string | number): Promise<KitsuEpisode[]> {
  if (!kitsuId) return [];
  
  const cacheKey = `kitsu-episodes:v2:${kitsuId}`;
  const cacheTTL = 3600; // 1 hour cache for episode data
  
  return cacheWrapGlobal(cacheKey, async () => {
    logger.info(`Fetching episodes for ID ${kitsuId}`);
    const startTime = Date.now();
    
    try {
      const params = {
        page: { limit: 20 }
      };
      
      const allEpisodes = await _fetchEpisodesRecursively(`anime/${kitsuId}/episodes`, params);
      logger.success(`Total episodes fetched: ${allEpisodes.length}`);
      
      // Track successful request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('kitsu', responseTime, true);
      
      return allEpisodes;
    } catch (error: any) {
      // Track failed request
      const responseTime = Date.now() - startTime;
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('kitsu', responseTime, false);
      
      const status = error.response?.status;
      const errorType = status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'api_error';
      requestTracker.logProviderError('kitsu', errorType, `getAnimeEpisodes failed: ${error.message}`, {
        kitsuId,
        status
      });
      
      logger.error(`Error fetching episodes for ID ${kitsuId}:`, (error as Error).message);
      return [];
    }
  }, cacheTTL);
}

async function _fetchEpisodesRecursively(
  endpoint: string, 
  params: { page: { limit: number } }, 
  offset: number = 0
): Promise<KitsuEpisode[]> {
  const currentParams = { 
    ...params, 
    page: { ...params.page, offset } 
  };
  
  const response = await kitsu.get(endpoint, { params: currentParams });
  
  if (response.links && response.links.next) {
    const nextOffset = offset + response.data.length;
    const nextEpisodes = await _fetchEpisodesRecursively(endpoint, params, nextOffset);
    return response.data.concat(nextEpisodes);
  }
  
  return response.data;
}

// -------------------- Helpers --------------------

async function fetchRelationshipList(url?: string): Promise<string[]> {
  if (!url) return []
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const json = await res.json()
    return ((json as any).data || []).map((i: any) => i.attributes.name)
  } catch {
    return []
  }
}

// -------------------- Main fetch --------------------

/**
 * Fetches a Kitsu anime by ID, including genres and characters.
 */
 async function getAnimeDetails(kitsuId: string | number) {
  if (!kitsuId) return null
  
  const startTime = Date.now();

  try {
    const response = await kitsu.get(`anime/${kitsuId}`, {
      params: {
        include: 'episodes,genres,characters,mediaRelationships.destination'
      }
    })

    const anime = response.data
    const included = response.included || []

    // try to read from included first
    let genres = included.filter((i: any) => i.type === 'genres').map((i: any) => i.attributes.name)
    let characters = included.filter((i: any) => i.type === 'characters').map((i: any) => i.attributes.name)

    // fallback if missing
    if (!genres.length)
      genres = await fetchRelationshipList(anime.relationships?.genres?.links?.related)
    if (!characters.length)
      characters = await fetchRelationshipList(anime.relationships?.characters?.links?.related)

    // Track successful request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, true);

    return { data: anime, included, genres, characters }
  } catch (error: any) {
    // Track failed request
    const responseTime = Date.now() - startTime;
    const requestTracker = require('./requestTracker');
    requestTracker.trackProviderCall('kitsu', responseTime, false);
    
    const status = error.response?.status;
    const errorType = status === 429 ? 'rate_limit' : status >= 500 ? 'server_error' : 'api_error';
    requestTracker.logProviderError('kitsu', errorType, `getAnimeDetails failed: ${error.message}`, {
      kitsuId,
      status
    });
    
    logger.error(`Error fetching anime details for ID ${kitsuId}:`, (error as Error).message)
    return null
  }
}

export {
  searchByName,
  getMultipleAnimeDetails,
  getAnimeEpisodes,
  getAnimeDetails
};

// CommonJS compatibility
module.exports = {
  searchByName,
  getMultipleAnimeDetails,
  getAnimeEpisodes,
  getAnimeDetails
};
