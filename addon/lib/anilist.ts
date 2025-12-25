const { httpPost } = require('../utils/httpClient');
const { cacheWrapGlobal } = require('./getCache');

const host = process.env.HOST_NAME && process.env.HOST_NAME.startsWith('http') 
  ? process.env.HOST_NAME 
  : `https://${process.env.HOST_NAME}`;

class AniListAPI {
  baseURL: string;
  cache: Map<any, any>;
  cacheTimeout: number;
  rateLimit: {
    limit: number;
    remaining: number;
    resetTime: number;
    lastRequestTime: number;
    minInterval: number;
  };
  requestQueue: Array<{ requestFn: () => Promise<any> | any; resolve: (v: any) => void; reject: (e: any) => void }>;
  isProcessingQueue: boolean;
  constructor() {
    this.baseURL = 'https://graphql.anilist.co';
    this.cache = new Map();
    this.cacheTimeout = 60 * 60 * 1000; // 1 hour
    
    // Rate limiting configuration
    this.rateLimit = {
      limit: 30, // Current degraded state limit (normally 90)
      remaining: 30,
      resetTime: 0,
      lastRequestTime: 0,
      minInterval: 2000 // Minimum 2 seconds between requests
    };
    
    // Request queue for rate limiting
    this.requestQueue = [];
    this.isProcessingQueue = false;
  }

  /**
   * Rate limiting and retry logic
   */
  async makeRateLimitedRequest(requestFn: () => Promise<any>, retries = 3): Promise<any> {
    const now = Date.now();
    
    // Check if we need to wait for rate limit reset
    if (this.rateLimit.resetTime > now) {
      const waitTime = this.rateLimit.resetTime - now + 1000; // Add 1 second buffer
      console.log(`[AniList] Rate limit exceeded, waiting ${waitTime}ms until reset`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.rateLimit.remaining = this.rateLimit.limit;
      this.rateLimit.resetTime = 0;
    }
    
    // Check minimum interval between requests
    const timeSinceLastRequest = now - this.rateLimit.lastRequestTime;
    if (timeSinceLastRequest < this.rateLimit.minInterval) {
      const waitTime = this.rateLimit.minInterval - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    const startTime = Date.now();
    try {
      const response = await requestFn();
      const responseTime = Date.now() - startTime;
      
      // Track successful request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('anilist', responseTime, true);
      
      // Update rate limit info from headers
      if (response.headers) {
        const limit = response.headers['x-ratelimit-limit'];
        const remaining = response.headers['x-ratelimit-remaining'];
        const reset = response.headers['x-ratelimit-reset'];
        
        if (limit) this.rateLimit.limit = parseInt(limit);
        if (remaining) this.rateLimit.remaining = parseInt(remaining);
        if (reset) this.rateLimit.resetTime = parseInt(reset) * 1000; // Convert to milliseconds
      }
      
      this.rateLimit.lastRequestTime = Date.now();
      return response;
      
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      
      // Track failed request
      const requestTracker = require('./requestTracker');
      requestTracker.trackProviderCall('anilist', responseTime, false);
      
      if (error.response?.status === 429) {
        // Rate limit exceeded
        const retryAfter = error.response.headers['retry-after'];
        const resetTime = error.response.headers['x-ratelimit-reset'];
        
        if (retryAfter) {
          const waitTime = parseInt(retryAfter) * 1000;
          console.log(`[AniList] Rate limit exceeded, waiting ${waitTime}ms (Retry-After)`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else if (resetTime) {
          const resetTimestamp = parseInt(resetTime) * 1000;
          const waitTime = resetTimestamp - Date.now() + 1000;
          console.log(`[AniList] Rate limit exceeded, waiting ${waitTime}ms until reset`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.rateLimit.remaining = 0;
        this.rateLimit.resetTime = resetTime ? parseInt(resetTime) * 1000 : Date.now() + 60000;
        
        // Retry the request
        if (retries > 0) {
          return this.makeRateLimitedRequest(requestFn, retries - 1);
        }
      }
      
      throw error;
    }
  }

  /**
   * Queue a request for rate limiting
   */
  async queueRequest(requestFn: () => Promise<any>): Promise<any> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ requestFn, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Process the request queue
   */
  async processQueue() {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      return;
    }
    
    this.isProcessingQueue = true;
    
    while (this.requestQueue.length > 0) {
      const item = this.requestQueue.shift();
      if (!item) break;
      const { requestFn, resolve, reject } = item;
      
      try {
        const result = await this.makeRateLimitedRequest(requestFn);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    }
    
    this.isProcessingQueue = false;
  }

  /**
   * Map list name to AniList MediaListStatus enum
   */
  mapListNameToStatus(listName: string): string | null {
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
   * Fetch all anime lists for a user (names and counts)
   */
  async fetchUserLists(username: string): Promise<any> {
    if (!username) {
      throw new Error('Username is required');
    }

    const query = `
      query($userName: String) {
        MediaListCollection(userName: $userName, type: ANIME) {
          lists {
            name
            isCustomList
            entries {
              media { id }
            }
          }
        }
      }
    `;

    try {
      const response = await this.makeRateLimitedRequest(() => 
        httpPost(this.baseURL, {
          query,
          variables: { userName: username }
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000
        })
      );

      const data = response.data?.data;
      const lists = data?.MediaListCollection?.lists || [];
      return {
        lists: lists.map((list: any) => ({
          name: list.name,
          isCustomList: list.isCustomList,
          entryCount: (list.entries && Array.isArray(list.entries)) ? list.entries.length : 0,
        }))
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Fetch items from a specific list with pagination
   * Returns items: [{ score, media: { id, idMal } }], hasMore, total
   */
  async fetchListItems(username: string, listName: string, page = 1, pageSize = 50, sort = 'ADDED_TIME_DESC'): Promise<any> {
    if (!username) {
      throw new Error('Username is required');
    }
    if (!listName) {
      throw new Error('List name is required');
    }

    const status = this.mapListNameToStatus(listName);

    if (status) {
      // Standard status list - use Page query for pagination
      const query = `
        query($userName: String, $status: MediaListStatus, $page: Int, $perPage: Int, $sort: [MediaListSort]) {
          Page(page: $page, perPage: $perPage) {
            pageInfo { hasNextPage total }
            mediaList(userName: $userName, type: ANIME, status: $status, sort: $sort) {
              score(format: POINT_100)
              media {
                id
                idMal
                title {
                  english
                  romaji
                  native
                }
                startDate {
                  year
                  month
                  day
                }
                endDate {
                  year
                  month
                  day
                }
                seasonYear
                duration
                format
                description
                coverImage {
                  large
                  medium
                  color
                }
              }
            }
          }
        }
      `;

      const response = await this.makeRateLimitedRequest(() => 
        httpPost(this.baseURL, {
          query,
          variables: {
            userName: username,
            status,
            page,
            perPage: pageSize,
            sort: [sort],
          }
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000
        })
      );

      const data = response.data?.data;
      const pageInfo = data?.Page?.pageInfo || { hasNextPage: false, total: 0 };
      const mediaList = data?.Page?.mediaList || [];

      const items = mediaList.map((entry: any) => ({
        score: entry.score,
        media: entry.media,
      }));

      return {
        items,
        hasMore: !!pageInfo.hasNextPage,
        total: pageInfo.total || 0,
      };
    } else {
      // Custom list - fetch all lists then find and paginate manually
      const query = `
        query($userName: String, $sort: [MediaListSort]) {
          MediaListCollection(userName: $userName, type: ANIME, sort: $sort) {
            lists {
              name
              isCustomList
              entries {
                score(format: POINT_100)
                media {
                  id
                  idMal
                  title {
                    english
                    romaji
                    native
                  }
                  startDate {
                    year
                    month
                    day
                  }
                  endDate {
                    year
                    month
                    day
                  }
                  seasonYear
                  duration
                  episodes
                  format
                  description
                  coverImage {
                    large
                    medium
                    color
                  }
                }
              }
            }
          }
        }
      `;

      const response = await this.makeRateLimitedRequest(() => 
        httpPost(this.baseURL, {
          query,
          variables: { userName: username, sort: [sort] }
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000
        })
      );

      const data = response.data?.data;
      const lists = data?.MediaListCollection?.lists || [];
      const targetList = lists.find((list: any) => list.name === listName);

      if (!targetList) {
        return { items: [], hasMore: false, total: 0 };
      }

      const allEntries = targetList.entries || [];
      const total = allEntries.length;
      const startIndex = (page - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      const paginatedEntries = allEntries.slice(startIndex, endIndex);

      const items = paginatedEntries.map((entry: any) => ({
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

  /**
   * GraphQL query for getting anime artwork by MAL ID
   */
  async getAnimeArtworkByMalId(malId: number): Promise<any> {
    const query = `
      query ($malId: Int) {
        Media(idMal: $malId, type: ANIME) {
          id
          idMal
          title {
            romaji
            english
            native
          }
          coverImage {
            large
            medium
            color
          }
          bannerImage
          description
          type
          format
          status
          episodes
          duration
          season
          seasonYear
          genres
          averageScore
          meanScore
          popularity
          trending
          favourites
          countryOfOrigin
          source
          hashtag
          trailer {
            id
            site
            thumbnail
          }
          externalLinks {
            id
            url
            site
            type
            language
          }
        }
      }
    `;

    try {
      const response = await this.makeRateLimitedRequest(() => 
        httpPost(this.baseURL, {
          query,
          variables: { malId: malId }
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 10000
        })
      );

      if (response.data?.data?.Media) {
        return response.data.data.Media;
      }
      
      console.log(`[AniList] No anime found for MAL ID: ${malId}`);
      return null;
    } catch (error: any) {
      console.error(`[AniList] Error fetching anime for MAL ID ${malId}:`, error.message);
      return null;
    }
  }

  /**
   * GraphQL query for getting multiple anime artworks by AniList IDs (aliasing)
   */
  async getMultipleAnimeArtworkByAnilistIds(anilistIds: number[]): Promise<any[]> {
    if (!anilistIds || anilistIds.length === 0) {
      return [];
    }

    // Build dynamic query with aliases - ONLY artwork fields
    const queryParts = anilistIds.map((anilistId: number, index: number) => `
      anime${index}: Media(id: ${anilistId}, type: ANIME) {
        id
        idMal
        coverImage {
          large
          medium
          color
        }
        bannerImage
      }
    `);

    const query = `
      query {
        ${queryParts.join('\n')}
      }
    `;

    try {
      console.log(`[AniList] Making batch request for ${anilistIds.length} AniList IDs: ${anilistIds.slice(0, 5).join(', ')}${anilistIds.length > 5 ? '...' : ''}`);
      
      const response = await this.makeRateLimitedRequest(() => 
        httpPost(this.baseURL, {
          query
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000
        })
      );

      if (response.data?.data) {
        const results = [];
        for (let i = 0; i < anilistIds.length; i++) {
          const anime = response.data.data[`anime${i}`];
          if (anime) {
            results.push(anime);
          }
        }
        console.log(`[AniList] Batch request successful: ${results.length}/${anilistIds.length} anime found`);
        return results;
      } else if (response.data?.errors) {
        console.log(`[AniList] GraphQL errors:`, response.data.errors);
        throw new Error(`AniList GraphQL errors: ${JSON.stringify(response.data.errors)}`);
      }

      return [];
    } catch (error: any) {
      console.error(`[AniList] Error fetching multiple anime for AniList IDs ${anilistIds.join(', ')}:`, error.message);
      if (error.response?.data?.errors) {
        console.log(`[AniList] GraphQL errors:`, error.response.data.errors);
      }
      throw error;
    }
  }

  /**
   * GraphQL query for getting multiple anime artworks by MAL IDs (aliasing) - DEPRECATED
   */
  async getMultipleAnimeArtwork(malIds: number[]): Promise<any[]> {
    if (!malIds || malIds.length === 0) {
      return [];
    }

    // Build dynamic query with aliases - ONLY artwork fields
    const queryParts = malIds.map((malId: number, index: number) => `
      anime${index}: Media(idMal: ${malId}, type: ANIME) {
        id
        idMal
        coverImage {
          large
          medium
          color
        }
        bannerImage
      }
    `);

    const query = `
      query {
        ${queryParts.join('\n')}
      }
    `;

    try {
      console.log(`[AniList] Making batch request for ${malIds.length} MAL IDs: ${malIds.slice(0, 5).join(', ')}${malIds.length > 5 ? '...' : ''}`);
      
      const response = await this.makeRateLimitedRequest(() => 
        httpPost(this.baseURL, {
          query
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000
        })
      );

      if (response.data?.data) {
        const results = [];
        for (let i = 0; i < malIds.length; i++) {
          const anime = response.data.data[`anime${i}`];
          if (anime) {
            results.push(anime);
          }
        }
        console.log(`[AniList] Successfully fetched ${results.length} anime from batch request`);
        return results;
      }
      
      console.log(`[AniList] No anime found for MAL IDs: ${malIds.join(', ')}`);
      return [];
    } catch (error: any) {
      console.error(`[AniList] Error fetching multiple anime for MAL IDs ${malIds.join(', ')}:`, error.message);
      if (error.response?.data) {
        console.error(`[AniList] GraphQL errors:`, error.response.data.errors);
      }
      return [];
    }
  }

  /**
   * Get poster image URL from AniList data
   */
  getPosterUrl(animeData: any): string | null {
    if (!animeData?.coverImage?.large) {
      return null;
    }
    return animeData.coverImage.large;
  }

  /**
   * Get background image URL from AniList data
   * Converts banner images to full-size backgrounds with proper processing
   * Falls back to cover image if banner is too small
   */
  getBackgroundUrl(animeData: any): string | null {
    // Prefer banner image, but fall back to cover image if banner is too small
    const bannerUrl = animeData?.bannerImage;
    const coverUrl = animeData?.coverImage?.large;
    
    if (!bannerUrl && !coverUrl) {
      return null;
    }
    
    // Use banner if available, otherwise use cover image
    const originalUrl = bannerUrl || coverUrl;
    const isBanner = !!bannerUrl; // Check if we're using a banner image
    
    // Use the new banner-to-background conversion endpoint
    // This provides better processing for banner images
    const params = new URLSearchParams({
      url: originalUrl,
      width: '1920',
      height: '1080',
      blur: isBanner ? '0.5' : '0', // Minimal blur for banners
      brightness: isBanner ? '0.98' : '1', // Keep original brightness
      contrast: '1.05', // Very slight contrast boost
      position: isBanner ? 'top' : 'center' // Use top positioning for banners to avoid cutting off content
    });
    
    const backgroundUrl = `${host}/api/image/banner-to-background?${params.toString()}`;
    
    return backgroundUrl;
  }

  /**
   * Get medium poster URL from AniList data
   */
  getMediumPosterUrl(animeData: any): string | null {
    if (!animeData?.coverImage?.medium) {
      return null;
    }
    return animeData.coverImage.medium;
  }

  /**
   * Get anime color theme from AniList data
   */
  getAnimeColor(animeData: any): string | null {
    return animeData?.coverImage?.color || null;
  }

  /**
   * Enhanced artwork getter with global caching
   */
  async getAnimeArtwork(malId: number | string): Promise<any> {
    return cacheWrapGlobal(`anilist-artwork:${malId}`, async () => {
      console.log(`[AniList] Fetching artwork for MAL ID: ${malId}`);
      const malIdNum = typeof malId === 'string' ? parseInt(malId) : malId;
      return await this.getAnimeArtworkByMalId(malIdNum);
    }, 30 * 24 * 60 * 60); // 30 days TTL
  }

  /**
   * Batch artwork getter using AniList IDs with global caching
   */
  async getBatchAnimeArtworkByAnilistIds(anilistIds: number[]): Promise<any[]> {
    if (!anilistIds || anilistIds.length === 0) return [];
    
    const batchSize = 50;
    const allResults = [];
    
    // Process in batches
    for (let i = 0; i < anilistIds.length; i += batchSize) {
      const batch = anilistIds.slice(i, i + batchSize);
      console.log(`[AniList] Processing AniList ID batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(anilistIds.length/batchSize)} (${batch.length} items)`);
      
      try {
        // Use global cache for the entire batch
        const batchKey = `anilist-batch-${batch.sort().join('-')}`;
        const batchResults = await cacheWrapGlobal(`anilist-batch:${batchKey}`, async () => {
          return await this.queueRequest(() => this.getMultipleAnimeArtworkByAnilistIds(batch));
        }, 30 * 24 * 60 * 60); // 30 days TTL
        
        allResults.push(...batchResults);
      } catch (error: any) {
        console.warn(`[AniList] AniList ID batch ${Math.floor(i/batchSize) + 1} failed:`, error.message);
        
        // Fallback to individual cached requests
        console.warn(`[AniList] Falling back to individual requests for batch of ${batch.length}`);
        const individualResults = await Promise.all(
          batch.map((anilistId: number) => this.getAnimeArtwork(`anilist:${anilistId}`))
        );
        allResults.push(...individualResults.filter(Boolean));
      }
    }
    
    const validResults = allResults.filter(Boolean);
    console.log(`[AniList] AniList ID batch fetch: ${validResults.length}/${anilistIds.length} successful`);
    return validResults;
  }

  /**
   * Batch artwork getter with global caching and proper batching (MAL IDs)
   */
  async getBatchAnimeArtwork(malIds: number[]): Promise<any[]> {
    if (!malIds || malIds.length === 0) return [];
    
    let batchSize = 50; // Back to 50 with minimal fields
    const allResults = [];
    
    // Process in batches
    for (let i = 0; i < malIds.length; i += batchSize) {
      const batch = malIds.slice(i, i + batchSize);
      console.log(`[AniList] Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(malIds.length/batchSize)} (${batch.length} items)`);
      
      try {
        // Use global cache for the entire batch with custom error handling
        const batchKey = `batch-${batch.sort().join('-')}`;
        const batchResults = await cacheWrapGlobal(`anilist-batch:${batchKey}`, async () => {
          return await this.queueRequest(() => this.getMultipleAnimeArtwork(batch));
        }, 30 * 24 * 60 * 60); // 30 days TTL - removed custom classifier for now
        
        allResults.push(...batchResults);
          } catch (error: any) {
        console.warn(`[AniList] Batch ${Math.floor(i/batchSize) + 1} failed:`, error.message);
        
        // If complexity error, try smaller batches
        if (error.message?.includes('Max query complexity') && batchSize > 5) {
          console.log(`[AniList] Reducing batch size from ${batchSize} to ${Math.floor(batchSize/2)} due to complexity`);
          batchSize = Math.floor(batchSize / 2);
          i -= batchSize; // Retry this batch with smaller size
          continue;
        }
        
        // Fallback to individual cached requests
        console.warn(`[AniList] Falling back to individual requests for batch of ${batch.length}`);
        const individualResults = await Promise.all(
          batch.map((malId: number) => this.getAnimeArtwork(malId))
        );
        allResults.push(...individualResults.filter(Boolean));
      }
    }
    
    const validResults = allResults.filter(Boolean);
    console.log(`[AniList] Batch fetch: ${validResults.length}/${malIds.length} successful`);
    return validResults;
  }

  /**
   * Get artwork URLs for catalog usage
   */
  async getCatalogArtwork(malIds: number[]): Promise<any[]> {
    const animeData = await this.getBatchAnimeArtwork(malIds);
    
    return animeData.map((anime: any) => ({
      malId: anime.idMal,
      poster: this.getPosterUrl(anime),
      background: this.getBackgroundUrl(anime),
      mediumPoster: this.getMediumPosterUrl(anime),
      color: this.getAnimeColor(anime),
      title: anime.title?.english || anime.title?.romaji || 'Unknown',
      type: anime.type,
      format: anime.format,
      status: anime.status,
      episodes: anime.episodes,
      season: anime.season,
      seasonYear: anime.seasonYear,
      genres: anime.genres || [],
      score: anime.averageScore,
      popularity: anime.popularity
    }));
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    console.log('[AniList] Cache cleared');
  }

  /**
   * Submit a rating to AniList
   * @param mediaId - AniList media ID
   * @param score - Rating score (1-100 scale)
   * @param accessToken - OAuth access token
   * @returns Promise with the response data
   */
  async submitRating(mediaId: number, score: number, accessToken: string): Promise<any> {
    if (!mediaId || !accessToken) {
      throw new Error('mediaId and accessToken are required');
    }
    
    if (score < 1 || score > 100) {
      throw new Error('score must be between 1 and 100');
    }
    
    const mutation = `
      mutation SaveMediaListEntry($mediaId: Int, $score: Float) {
        SaveMediaListEntry(mediaId: $mediaId, score: $score) {
          mediaId
          score
        }
      }
    `;
    
    const variables = {
      mediaId: mediaId,
      score: score
    };
    
    try {
      const response = await this.makeRateLimitedRequest(() => 
        httpPost(this.baseURL, {
          query: mutation,
          variables: variables
        }, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        })
      );
      
      return response;
    } catch (error: any) {
      throw error;
    }
  }

  /**
   * Get rate limit status
   */
  getRateLimitStatus() {
    const now = Date.now();
    const timeUntilReset = this.rateLimit.resetTime > now ? this.rateLimit.resetTime - now : 0;
    
    return {
      limit: this.rateLimit.limit,
      remaining: this.rateLimit.remaining,
      resetTime: this.rateLimit.resetTime,
      timeUntilReset: timeUntilReset,
      isLimited: this.rateLimit.remaining <= 0,
      queueLength: this.requestQueue.length,
      isProcessingQueue: this.isProcessingQueue
    };
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const now = Date.now();
    const validEntries = Array.from(this.cache.values()).filter(
      (entry: any) => now - entry.timestamp < this.cacheTimeout
    );
    
    return {
      totalEntries: this.cache.size,
      validEntries: validEntries.length,
      expiredEntries: this.cache.size - validEntries.length,
      cacheTimeout: this.cacheTimeout,
      rateLimit: this.getRateLimitStatus()
    };
  }
}
const anilist = new AniListAPI();
module.exports = anilist;
