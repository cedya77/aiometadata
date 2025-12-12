/**
 * AniList Catalog Module
 * Provides functions for fetching user lists from AniList GraphQL API
 * for use as browsable catalogs in Stremio.
 */

import axios, { AxiosResponse } from 'axios';

const ANILIST_GRAPHQL_URL = 'https://graphql.anilist.co';

// Rate limiting state (tracks API response headers)
const rateLimit = {
  limit: 30, // Degraded state limit (normally 90)
  remaining: 30,
  resetTime: 0, // Unix timestamp when rate limit resets
};

/**
 * AniList list entry from MediaListCollection
 * Only contains IDs since metadata is hydrated separately
 */
export interface AniListMediaEntry {
  score: number;
  media: {
    id: number;
    idMal: number | null;
  };
}

/**
 * AniList list structure from MediaListCollection
 */
export interface AniListList {
  name: string;
  isCustomList: boolean;
  entries: AniListMediaEntry[];
}

/**
 * Response structure for fetchUserLists
 */
export interface FetchUserListsResponse {
  lists: Array<{
    name: string;
    isCustomList: boolean;
    entryCount: number;
  }>;
}

/**
 * Response structure for fetchListItems
 */
export interface FetchListItemsResponse {
  items: AniListMediaEntry[];
  hasMore: boolean;
  total: number;
}

/**
 * Update rate limit state from response headers
 */
function updateRateLimitFromHeaders(headers: Record<string, string>): void {
  if (headers['x-ratelimit-limit']) {
    rateLimit.limit = parseInt(headers['x-ratelimit-limit']);
  }
  if (headers['x-ratelimit-remaining']) {
    rateLimit.remaining = parseInt(headers['x-ratelimit-remaining']);
  }
  if (headers['x-ratelimit-reset']) {
    rateLimit.resetTime = parseInt(headers['x-ratelimit-reset']) * 1000; // Convert to ms
  }
}

/**
 * Wait if we've hit the rate limit
 */
async function waitForRateLimitReset(): Promise<void> {
  const now = Date.now();
  
  if (rateLimit.remaining <= 0 && rateLimit.resetTime > now) {
    const waitTime = rateLimit.resetTime - now + 1000; // Add 1s buffer
    console.log(`[AniListCatalog] Rate limit reached, waiting ${Math.ceil(waitTime / 1000)}s until reset`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    rateLimit.remaining = rateLimit.limit; // Reset after waiting
  }
}

/**
 * Make a rate-limited request to AniList GraphQL API
 */
async function makeAniListRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  retries = 3
): Promise<T> {
  // Wait if we've exhausted our rate limit
  await waitForRateLimitReset();

  try {
    const response: AxiosResponse = await axios.post(
      ANILIST_GRAPHQL_URL,
      { query, variables },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 15000,
      }
    );

    // Update rate limit state from successful response
    updateRateLimitFromHeaders(response.headers as Record<string, string>);

    if (response.data?.errors) {
      const error = response.data.errors[0];
      // Check for rate limit error in GraphQL response
      if (error?.status === 429) {
        throw { response: { status: 429, headers: response.headers } };
      }
      throw new Error(`AniList GraphQL error: ${error?.message || 'Unknown error'}`);
    }

    return response.data?.data as T;
  } catch (error: unknown) {
    const axiosError = error as {
      response?: { status?: number; headers?: Record<string, string> };
    };

    // Handle rate limiting (429)
    if (axiosError.response?.status === 429) {
      const headers = axiosError.response.headers || {};
      updateRateLimitFromHeaders(headers);

      // Use Retry-After header if available, otherwise use reset time
      const retryAfter = headers['retry-after'];
      let waitTime: number;

      if (retryAfter) {
        waitTime = parseInt(retryAfter) * 1000;
      } else if (rateLimit.resetTime > Date.now()) {
        waitTime = rateLimit.resetTime - Date.now() + 1000;
      } else {
        waitTime = 60000; // Default 1 minute timeout
      }

      console.log(`[AniListCatalog] Rate limited (429), waiting ${Math.ceil(waitTime / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, waitTime));

      if (retries > 0) {
        rateLimit.remaining = rateLimit.limit; // Reset after waiting
        return makeAniListRequest<T>(query, variables, retries - 1);
      }
    }

    throw error;
  }
}

/**
 * GraphQL query for fetching all user lists
 */
const FETCH_USER_LISTS_QUERY = `
  query($userName: String) {
    MediaListCollection(userName: $userName, type: ANIME) {
      lists {
        name
        isCustomList
        entries {
          score(format: POINT_100)
          media {
            id
          }
        }
      }
    }
  }
`;

/**
 * GraphQL query for fetching list items (IDs only for hydration)
 */
const FETCH_LIST_ITEMS_QUERY = `
  query($userName: String, $status: MediaListStatus, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo {
        hasNextPage
        total
      }
      mediaList(userName: $userName, type: ANIME, status: $status) {
        score(format: POINT_100)
        media {
          id
          idMal
        }
      }
    }
  }
`;

/**
 * GraphQL query for fetching custom list items (IDs only for hydration)
 */
const FETCH_CUSTOM_LIST_ITEMS_QUERY = `
  query($userName: String) {
    MediaListCollection(userName: $userName, type: ANIME) {
      lists {
        name
        isCustomList
        entries {
          score(format: POINT_100)
          media {
            id
            idMal
          }
        }
      }
    }
  }
`;

/**
 * Map list name to AniList MediaListStatus enum
 */
function mapListNameToStatus(listName: string): string | null {
  const statusMap: Record<string, string> = {
    'Watching': 'CURRENT',
    'Completed': 'COMPLETED',
    'Planning': 'PLANNING',
    'Plan to Watch': 'PLANNING',
    'Dropped': 'DROPPED',
    'Paused': 'PAUSED',
    'On Hold': 'PAUSED',
    'Rewatching': 'REPEATING',
  };
  
  return statusMap[listName] || null;
}

/**
 * Fetch all anime lists for a user
 * Returns list names, whether they're custom, and entry counts
 */
export async function fetchUserLists(username: string): Promise<FetchUserListsResponse> {
  if (!username) {
    throw new Error('Username is required');
  }
  
  console.log(`[AniListCatalog] Fetching lists for user: ${username}`);
  
  interface MediaListCollectionResponse {
    MediaListCollection: {
      lists: Array<{
        name: string;
        isCustomList: boolean;
        entries: Array<{ media: { id: number } }>;
      }>;
    };
  }
  
  const data = await makeAniListRequest<MediaListCollectionResponse>(
    FETCH_USER_LISTS_QUERY,
    { userName: username }
  );
  
  if (!data?.MediaListCollection?.lists) {
    console.log(`[AniListCatalog] No lists found for user: ${username}`);
    return { lists: [] };
  }
  
  const lists = data.MediaListCollection.lists.map(list => ({
    name: list.name,
    isCustomList: list.isCustomList,
    entryCount: list.entries?.length || 0,
  }));
  
  console.log(`[AniListCatalog] Found ${lists.length} lists for user: ${username}`);
  
  return { lists };
}

/**
 * Fetch items from a specific list with pagination
 */
export async function fetchListItems(
  username: string,
  listName: string,
  page = 1,
  pageSize = 50
): Promise<FetchListItemsResponse> {
  if (!username) {
    throw new Error('Username is required');
  }
  
  if (!listName) {
    throw new Error('List name is required');
  }
  
  console.log(`[AniListCatalog] Fetching items from list "${listName}" for user: ${username}, page: ${page}`);
  
  // Check if this is a standard status list or custom list
  const status = mapListNameToStatus(listName);
  
  if (status) {
    // Standard status list - use Page query for pagination
    interface PageResponse {
      Page: {
        pageInfo: {
          hasNextPage: boolean;
          total: number;
        };
        mediaList: Array<{
          score: number;
          media: AniListMediaEntry['media'];
        }>;
      };
    }
    
    const data = await makeAniListRequest<PageResponse>(
      FETCH_LIST_ITEMS_QUERY,
      {
        userName: username,
        status: status,
        page: page,
        perPage: pageSize,
      }
    );
    
    if (!data?.Page?.mediaList) {
      return { items: [], hasMore: false, total: 0 };
    }
    
    const items: AniListMediaEntry[] = data.Page.mediaList.map(entry => ({
      score: entry.score,
      media: entry.media,
    }));
    
    return {
      items,
      hasMore: data.Page.pageInfo.hasNextPage,
      total: data.Page.pageInfo.total,
    };
  } else {
    // Custom list - need to fetch all and paginate manually
    interface MediaListCollectionResponse {
      MediaListCollection: {
        lists: Array<{
          name: string;
          isCustomList: boolean;
          entries: Array<{
            score: number;
            media: AniListMediaEntry['media'];
          }>;
        }>;
      };
    }
    
    const data = await makeAniListRequest<MediaListCollectionResponse>(
      FETCH_CUSTOM_LIST_ITEMS_QUERY,
      { userName: username }
    );
    
    if (!data?.MediaListCollection?.lists) {
      return { items: [], hasMore: false, total: 0 };
    }
    
    // Find the specific custom list
    const targetList = data.MediaListCollection.lists.find(
      list => list.name === listName
    );
    
    if (!targetList) {
      console.log(`[AniListCatalog] Custom list "${listName}" not found for user: ${username}`);
      return { items: [], hasMore: false, total: 0 };
    }
    
    const allEntries = targetList.entries || [];
    const total = allEntries.length;
    
    // Manual pagination
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedEntries = allEntries.slice(startIndex, endIndex);
    
    const items: AniListMediaEntry[] = paginatedEntries.map(entry => ({
      score: entry.score,
      media: entry.media,
    }));
    
    return {
      items,
      hasMore: endIndex < total,
      total,
    };
  }
}

export default {
  fetchUserLists,
  fetchListItems,
};
