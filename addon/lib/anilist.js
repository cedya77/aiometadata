const axios = require('axios');
const { cacheWrapGlobal } = require('./getCache');

const host = process.env.HOST_NAME.startsWith('http')
  ? process.env.HOST_NAME
  : `https://${process.env.HOST_NAME}`;

class AniListAPI {
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
  async makeRateLimitedRequest(requestFn, retries = 3) {
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
    
    try {
      const response = await requestFn();
      
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
      
    } catch (error) {
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
          console.log(`[AniList] Retrying request after rate limit (${retries} retries left)`);
          return this.makeRateLimitedRequest(requestFn, retries - 1);
        }
      }
      
      throw error;
    }
  }

  /**
   * Queue a request for rate limiting
   */
  async queueRequest(requestFn) {
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
      const { requestFn, resolve, reject } = this.requestQueue.shift();
      
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
   * GraphQL query for getting anime artwork by MAL ID
   */
  async getAnimeArtworkByMalId(malId) {
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
        axios.post(this.baseURL, {
          query,
          variables: { malId: parseInt(malId) }
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
    } catch (error) {
      console.error(`[AniList] Error fetching anime for MAL ID ${malId}:`, error.message);
      return null;
    }
  }

  /**
   * GraphQL query for getting multiple anime artworks by AniList IDs (aliasing)
   */
  async getMultipleAnimeArtworkByAnilistIds(anilistIds) {
    if (!anilistIds || anilistIds.length === 0) {
      return [];
    }

    // Build dynamic query with aliases - ONLY artwork fields
    const queryParts = anilistIds.map((anilistId, index) => `
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
        axios.post(this.baseURL, {
          query
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 15000
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
    } catch (error) {
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
  async getMultipleAnimeArtwork(malIds) {
    if (!malIds || malIds.length === 0) {
      return [];
    }

    // Build dynamic query with aliases - ONLY artwork fields
    const queryParts = malIds.map((malId, index) => `
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
        axios.post(this.baseURL, {
          query
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 15000
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
    } catch (error) {
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
  getPosterUrl(animeData) {
    if (!animeData?.coverImage?.large) {
      return null;
    }
    return animeData.coverImage.large;
  }

  /**
   * Get background image URL from AniList data
   * Resizes banner images for better Stremio display
   * Falls back to cover image if banner is too small
   */
  getBackgroundUrl(animeData) {
    // Prefer banner image, but fall back to cover image if banner is too small
    const bannerUrl = animeData?.bannerImage;
    const coverUrl = animeData?.coverImage?.large;
    
    if (!bannerUrl && !coverUrl) {
      return null;
    }
    
    // Use banner if available, otherwise use cover image
    const originalUrl = bannerUrl || coverUrl;
    
    // Use our own image resize endpoint with maximum quality 16:9
    // This will resize to the highest possible 16:9 resolution while maintaining quality
    // Sharp will automatically calculate the optimal dimensions and upscale if needed
    const resizedUrl = `${host}/resize-image?url=${encodeURIComponent(originalUrl)}&fit=cover&output=jpg&q=95`;
    
    return resizedUrl;
  }

  /**
   * Get medium poster URL from AniList data
   */
  getMediumPosterUrl(animeData) {
    if (!animeData?.coverImage?.medium) {
      return null;
    }
    return animeData.coverImage.medium;
  }

  /**
   * Get anime color theme from AniList data
   */
  getAnimeColor(animeData) {
    return animeData?.coverImage?.color || null;
  }

  /**
   * Enhanced artwork getter with global caching
   */
  async getAnimeArtwork(malId) {
    return cacheWrapGlobal(`anilist-artwork:${malId}`, async () => {
      console.log(`[AniList] Fetching artwork for MAL ID: ${malId}`);
      return await this.getAnimeArtworkByMalId(malId);
    }, 30 * 24 * 60 * 60); // 30 days TTL
  }

  /**
   * Batch artwork getter using AniList IDs with global caching
   */
  async getBatchAnimeArtworkByAnilistIds(anilistIds) {
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
      } catch (error) {
        console.warn(`[AniList] AniList ID batch ${Math.floor(i/batchSize) + 1} failed:`, error.message);
        
        // Fallback to individual cached requests
        console.warn(`[AniList] Falling back to individual requests for batch of ${batch.length}`);
        const individualResults = await Promise.all(
          batch.map(anilistId => this.getAnimeArtwork(`anilist:${anilistId}`))
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
  async getBatchAnimeArtwork(malIds) {
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
      } catch (error) {
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
          batch.map(malId => this.getAnimeArtwork(malId))
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
  async getCatalogArtwork(malIds) {
    const animeData = await this.getBatchAnimeArtwork(malIds);
    
    return animeData.map(anime => ({
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
      entry => now - entry.timestamp < this.cacheTimeout
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

module.exports = new AniListAPI();
