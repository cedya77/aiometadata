import Kitsu from 'kitsu';
import axios, { AxiosResponse } from 'axios';
import { cacheWrapGlobal } from './getCache.js';

// Initialize Kitsu client
const kitsu = new Kitsu();

// Type definitions for Kitsu API responses
interface KitsuAnimeAttributes {
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

interface KitsuAnime {
  id: string;
  type: string;
  attributes: KitsuAnimeAttributes;
  relationships: {
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
}

interface KitsuEpisodeAttributes {
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

interface KitsuEpisode {
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
async function searchByName(query: string): Promise<KitsuAnime[]> {
  if (!query) return [];
  
  try {
    const response = await kitsu.fetch('anime', {
      filter: { text: query },
      page: { limit: 20 }
    } as any);
    return response.data || [];
  } catch (error) {
    console.error(`[Kitsu Client] Error searching for "${query}":`, (error as Error).message);
    return [];
  }
}

/**
 * Fetches the full details for multiple anime by their Kitsu IDs in a single request.
 * @param ids - An array of Kitsu IDs.
 * @returns A promise that resolves to an array of Kitsu anime resource objects.
 */
async function getMultipleAnimeDetails(ids: (string | number)[]): Promise<KitsuAnime[]> {
  if (!ids || ids.length === 0) {
    return [];
  }
  
  try {
    console.log(`[Kitsu Client] Fetching details for IDs: ${ids.join(',')}`);
    
    // Use direct API call to bypass Kitsu library filter issues
    const url = `https://kitsu.io/api/edge/anime?filter[id]=${ids.join(',')}`;
    
    console.log(`[Kitsu Client] Direct API URL: ${url}`);
    
    const response: AxiosResponse<KitsuDirectApiResponse> = await axios.get(url, {
      headers: {
        'Accept': 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json'
      },
      timeout: 10000
    });
    
    console.log(`[Kitsu Client] Direct API received ${response.data?.data?.length || 0} results`);
    const receivedIds = response.data?.data?.map(item => item.id) || [];
    console.log(`[Kitsu Client] Received IDs: ${receivedIds.join(',')}`);
    
    return response.data?.data || [];
    
  } catch (error) {
    console.error(`[Kitsu Client] Error fetching details for IDs ${ids.join(',')}:`, (error as Error).message);
    return [];
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
    console.log(`[Kitsu Client] Fetching episodes for ID ${kitsuId}`);
    
    try {
      const params = {
        page: { limit: 20 }
      };
      
      const allEpisodes = await _fetchEpisodesRecursively(`anime/${kitsuId}/episodes`, params);
      console.log(`[Kitsu Client] Total episodes fetched: ${allEpisodes.length}`);
      return allEpisodes;
    } catch (error) {
      console.error(`[Kitsu Client] Error fetching episodes for ID ${kitsuId}:`, (error as Error).message);
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

/**
 * Fetches detailed anime information including relationships and episodes.
 * @param kitsuId - The Kitsu anime ID.
 * @returns A promise that resolves to detailed anime object.
 */
async function getAnimeDetails(kitsuId: string | number): Promise<KitsuAnime | null> {
  if (!kitsuId) return null;
  
  try {
    const response = await kitsu.fetch('anime', {
      filter: { id: kitsuId },
      include: 'episodes,genres,mediaRelationships.destination'
    } as any);
    
    return response.data[0] || null;
  } catch (error) {
    console.error(`[Kitsu Client] Error fetching anime details for ID ${kitsuId}:`, (error as Error).message);
    return null;
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
