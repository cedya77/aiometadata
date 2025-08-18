const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { redis } = require('./getCache'); 
const kitsu = require('./kitsu');

// from  https://github.com/Fribb/anime-lists
const REMOTE_MAPPING_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json';
const LOCAL_CACHE_PATH = path.join(__dirname, '..', 'data', 'anime-list-full.json.cache');
const REDIS_ETAG_KEY = 'anime-list-etag'; 
const UPDATE_INTERVAL_HOURS = parseInt(process.env.ANIME_LIST_UPDATE_INTERVAL_HOURS) || 24; // Update every 24 hours (configurable)

let animeIdMap = new Map();
let tvdbIdToAnimeListMap = new Map();
let isInitialized = false;
let tvdbIdMap = new Map();
const franchiseMapCache = new Map();
let tmdbIndexArray; 
const kitsuToImdbCache = new Map();
let imdbIdToAnimeListMap = new Map();
let updateInterval = null;

function processAndIndexData(jsonData) {
  const animeList = JSON.parse(jsonData);
  animeIdMap.clear();
  tvdbIdMap.clear();
  tvdbIdToAnimeListMap.clear();
  imdbIdToAnimeListMap.clear();
  for (const item of animeList) {
    if (item.mal_id) {
      animeIdMap.set(item.mal_id, item);
    }
    if (item.thetvdb_id) {
      const tvdbId = item.thetvdb_id;
      // If we haven't seen this TVDB ID before, create a new array for it
      if (!tvdbIdToAnimeListMap.has(tvdbId)) {
        tvdbIdToAnimeListMap.set(tvdbId, []);
      }
      tvdbIdToAnimeListMap.get(tvdbId).push(item);
    }
    if (item.imdb_id) {
      const imdbId = item.imdb_id;
      if (!imdbIdToAnimeListMap.has(imdbId)) {
        imdbIdToAnimeListMap.set(imdbId, []);
      }
      imdbIdToAnimeListMap.get(imdbId).push(item);
    }
  }
  tmdbIndexArray = animeList.filter(item => item.themoviedb_id);
  isInitialized = true;
  console.log(`[ID Mapper] Successfully loaded and indexed ${animeIdMap.size} anime mappings.`);
}

/**
 * Downloads and processes the anime mapping file.
 * It uses Redis and ETags to check if the remote file has changed,
 * avoiding a full download if the local cache is up-to-date.
 */
async function downloadAndProcessAnimeList() {
  const useRedisCache = redis; 

  try {
    if (useRedisCache) {
      const savedEtag = await redis.get(REDIS_ETAG_KEY);
      const headers = (await axios.head(REMOTE_MAPPING_URL, { timeout: 10000 })).headers;
      const remoteEtag = headers.etag;

      console.log(`[ID Mapper] Saved ETag: ${savedEtag} | Remote ETag: ${remoteEtag}`);

      if (savedEtag && remoteEtag && savedEtag === remoteEtag) {
        try {
          console.log('[ID Mapper] No changes detected. Loading from local disk cache...');
          const fileContent = await fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
          processAndIndexData(fileContent);
          return;
        } catch (e) {
          console.warn('[ID Mapper] ETag matched, but local cache was unreadable. Forcing re-download.');
        }
      }
    } else {
      console.log('[ID Mapper] Redis cache is disabled. Proceeding to download.');
    }

    console.log('[ID Mapper] Downloading full list...');
    const response = await axios.get(REMOTE_MAPPING_URL, { timeout: 45000 });
    const jsonData = JSON.stringify(response.data);

    
    await fs.mkdir(path.dirname(LOCAL_CACHE_PATH), { recursive: true });
    await fs.writeFile(LOCAL_CACHE_PATH, jsonData, 'utf-8');
    
    if (useRedisCache) {
      await redis.set(REDIS_ETAG_KEY, response.headers.etag);
    }
    
    processAndIndexData(jsonData);

  } catch (error) {
    console.error(`[ID Mapper] An error occurred during remote download: ${error.message}`);
    console.log('[ID Mapper] Attempting to fall back to local disk cache...');
    
    try {
      const fileContent = await fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
      console.log('[ID Mapper] Successfully loaded data from local cache on fallback.');
      processAndIndexData(fileContent);
    } catch (fallbackError) {
      console.error('[ID Mapper] CRITICAL: Fallback to local cache also failed. Mapper will be empty.');
    }
  }
}

/**
 * Loads the anime mapping file into memory on addon startup.
 * It uses Redis and ETags to check if the remote file has changed,
 * avoiding a full download if the local cache is up-to-date.
 */
async function initializeMapper() {
  if (isInitialized) return;

  await downloadAndProcessAnimeList();
  
  // Schedule periodic updates
  if (!updateInterval) {
    const intervalMs = UPDATE_INTERVAL_HOURS * 60 * 60 * 1000; // Convert hours to milliseconds
    updateInterval = setInterval(async () => {
      console.log(`[ID Mapper] Running scheduled update (every ${UPDATE_INTERVAL_HOURS} hours)...`);
      try {
        await downloadAndProcessAnimeList();
        console.log('[ID Mapper] Scheduled update completed successfully.');
      } catch (error) {
        console.error('[ID Mapper] Scheduled update failed:', error.message);
      }
    }, intervalMs);
    
    console.log(`[ID Mapper] Scheduled periodic updates every ${UPDATE_INTERVAL_HOURS} hours.`);
  }
}

/**
 * Creates a mapping of TVDB Season Number -> Kitsu ID for a given franchise.
 * This is the core of the new, reliable seasonal mapping.
 * OVAs are assigned to season 0 to avoid conflicts with main TV series.
 */
async function buildFranchiseMapFromTvdbId(tvdbId) {
  const numericTvdbId = parseInt(tvdbId, 10);
  if (franchiseMapCache.has(numericTvdbId)) {
    return franchiseMapCache.get(numericTvdbId);
  }

  const franchiseSiblings = tvdbIdToAnimeListMap.get(numericTvdbId);
  if (!franchiseSiblings || franchiseSiblings.length === 0) return null;

  try {
    const kitsuIds = franchiseSiblings.map(s => s.kitsu_id).filter(Boolean);
    const kitsuDetails = await kitsu.getMultipleAnimeDetails(kitsuIds);
    const desiredTvTypes = new Set(['tv', 'ova', 'ona']);
    const kitsuTvSeasons = kitsuDetails.filter(item => 
        desiredTvTypes.has(item.attributes?.subtype.toLowerCase())
    );

    // Separate TV series from OVAs/ONAs
    const tvSeries = kitsuTvSeasons.filter(item => 
        item.attributes?.subtype.toLowerCase() === 'tv'
    );
    const ovasAndOnas = kitsuTvSeasons.filter(item => 
        ['ova', 'ona'].includes(item.attributes?.subtype.toLowerCase())
    );

    // Sort TV series by start date for main season numbering
    const sortedTvSeries = tvSeries.sort((a, b) => {
      const aDate = new Date(a.attributes?.startDate || '9999-12-31');
      const bDate = new Date(b.attributes?.startDate || '9999-12-31');
      return aDate - bDate;
    });

    // Sort OVAs/ONAs by start date
    const sortedOvasAndOnas = ovasAndOnas.sort((a, b) => {
      const aDate = new Date(a.attributes?.startDate || '9999-12-31');
      const bDate = new Date(b.attributes?.startDate || '9999-12-31');
      return aDate - bDate;
    });

    const seasonToKitsuMap = new Map();

    // Assign main TV series to seasons 1, 2, 3, etc.
    sortedTvSeries.forEach((kitsuItem, index) => {
      const seasonNumber = index + 1;
      seasonToKitsuMap.set(seasonNumber, parseInt(kitsuItem.id, 10));
    });

    // Assign OVAs/ONAs to season 0 (all OVAs share season 0)
    // Note: Stremio doesn't support negative season numbers, so all OVAs use season 0
    if (sortedOvasAndOnas.length > 0) {
      // Use the first (earliest) OVA for season 0
      seasonToKitsuMap.set(0, parseInt(sortedOvasAndOnas[0].id, 10));
    }

    console.log(`[ID Mapper] Built franchise map for TVDB ${tvdbId}:`, seasonToKitsuMap);
    franchiseMapCache.set(numericTvdbId, seasonToKitsuMap);
    return seasonToKitsuMap;

  } catch (error) {
    console.error(`[ID Mapper] Failed to build franchise map for TVDB ${tvdbId}:`, error);
    return null;
  }
}

/**
 * The public function to get a Kitsu ID for a specific TVDB season.
 * It uses the franchise map internally.
 * Supports special season numbers: 0 for single OVA, negative numbers for multiple OVAs.
 */
async function resolveKitsuIdFromTvdbSeason(tvdbId, seasonNumber) {
    if (!isInitialized) return null;
    
    const franchiseMap = await buildFranchiseMapFromTvdbId(tvdbId);
    if (!franchiseMap) {
      console.warn(`[ID Mapper] No franchise map available for TVDB ${tvdbId}`);
      return null;
    }
    
    const foundKitsuId = franchiseMap.get(seasonNumber) || null;
    if (foundKitsuId) {
      let seasonType = 'TV';
      if (seasonNumber === 0) {
        seasonType = 'OVA/ONA';
      }
      console.log(`[ID Mapper] Resolved TVDB S${seasonNumber} (${seasonType}) to Kitsu ID ${foundKitsuId}`);
    } else {
      console.warn(`[ID Mapper] No Kitsu ID found for S${seasonNumber} in franchise map for TVDB ${tvdbId}`);
      
      // Provide helpful debugging info about available seasons
      const availableSeasons = Array.from(franchiseMap.keys()).sort((a, b) => a - b);
      console.log(`[ID Mapper] Available seasons for TVDB ${tvdbId}: ${availableSeasons.join(', ')}`);
    }
    return foundKitsuId;
}

/**
 * Resolves Kitsu ID for a specific TMDB season number.
 * Uses franchise mapping to find the corresponding Kitsu season.
 * 
 * @param {string|number} tmdbId - The TMDB ID of the series
 * @param {number} seasonNumber - The season number to resolve
 * @returns {Promise<string|null>} The Kitsu ID for the season, or null if not found
 */
async function resolveKitsuIdFromTmdbSeason(tmdbId, seasonNumber) {
    if (!isInitialized) return null;
    
    // Get franchise information for this TMDB ID
    const franchiseInfo = await getFranchiseInfoFromTmdbId(tmdbId);
    
    if (!franchiseInfo) {
      console.warn(`[ID Mapper] No franchise info found for TMDB ID ${tmdbId}`);
      return null;
    }
    
    console.log(`[ID Mapper] Resolving TMDB S${seasonNumber} for ${tmdbId} (scenario: ${franchiseInfo.mappingScenario})`);
    
    // Check if episode-level mapping is needed (like Dan Da Dan scenario)
    if (franchiseInfo.needsEpisodeMapping) {
      console.log(`[ID Mapper] Episode-level mapping detected for TMDB ${tmdbId} (${franchiseInfo.tvSeriesCount} Kitsu entries for 1 TMDB season)`);
      
      // For episode-level mapping, we need to return a representative Kitsu ID
      // The actual episode-specific mapping will be done in getMeta.js
      const firstKitsuEntry = franchiseInfo.kitsuDetails
        .filter(entry => entry.subtype?.toLowerCase() === 'tv')
        .sort((a, b) => new Date(a.startDate || '9999-12-31') - new Date(b.startDate || '9999-12-31'))[0];
      
      if (firstKitsuEntry) {
        console.log(`[ID Mapper] Using first Kitsu ID ${firstKitsuEntry.id} as representative for episode-level mapping`);
        return firstKitsuEntry.id;
      }
    }
    
    // Check if the requested season exists in our mapping
    if (!franchiseInfo.seasons[seasonNumber]) {
      console.warn(`[ID Mapper] Season ${seasonNumber} not found in franchise mapping for TMDB ${tmdbId}`);
      console.log(`[ID Mapper] Available seasons: ${franchiseInfo.availableSeasonNumbers.join(', ')}`);
      
      // For complex scenarios, try to find the best match
      if (franchiseInfo.mappingScenario === 'tv_series_with_ovas' && seasonNumber > 0) {
        // If requesting a TV season but only have TV+OVA, return the TV series
        const tvSeason = Object.entries(franchiseInfo.seasons).find(([num, info]) => 
          info.mappingType === 'tv_series'
        );
        if (tvSeason) {
          const [seasonNum, info] = tvSeason;
          console.log(`[ID Mapper] Using TV series season ${seasonNum} (Kitsu ID ${info.kitsuId}) for TMDB S${seasonNumber}`);
          return info.kitsuId;
        }
      }
      
      // Fallback to first available season
      const firstSeason = franchiseInfo.availableSeasonNumbers[0];
      const firstSeasonInfo = franchiseInfo.seasons[firstSeason];
      console.log(`[ID Mapper] Using fallback season ${firstSeason} (Kitsu ID ${firstSeasonInfo.kitsuId}) for TMDB S${seasonNumber}`);
      return firstSeasonInfo.kitsuId;
    }
    
    const seasonInfo = franchiseInfo.seasons[seasonNumber];
    console.log(`[ID Mapper] Resolved TMDB S${seasonNumber} to Kitsu ID ${seasonInfo.kitsuId} (${seasonInfo.mappingType})`);
    console.log(`[ID Mapper] Season details: ${seasonInfo.title} (${seasonInfo.episodeCount} episodes, started ${seasonInfo.startDate})`);
    
    return seasonInfo.kitsuId;
}

/**
 * Gets IMDB episode ID for a specific TMDB episode using pre-fetched Cinemeta videos data.
 * Uses episode air dates to map TMDB episodes to IMDB episodes.
 * 
 * @param {string|number} tmdbId - The TMDB ID of the series
 * @param {number} seasonNumber - The season number
 * @param {number} episodeNumber - The episode number
 * @param {string} episodeAirDate - The episode air date (ISO string)
 * @param {Array} cinemetaVideos - Pre-fetched Cinemeta videos array
 * @returns {string|null} The IMDB episode ID in format "imdbId:seasonNumber:episodeNumber", or null if not found
 */
function getImdbEpisodeIdFromTmdbEpisode(tmdbId, seasonNumber, episodeNumber, episodeAirDate, cinemetaVideos) {
    if (!isInitialized) return null;
    
    // First, try to find the TMDB ID in our mappings
    const tmdbMappings = Array.from(animeIdMap.values())
      .filter(mapping => mapping.themoviedb_id === tmdbId);
    
    if (tmdbMappings.length === 0) {
      console.warn(`[ID Mapper] No TMDB mapping found for TMDB ID ${tmdbId}`);
      return null;
    }
    
    // Get the IMDB ID from the mapping
    const imdbId = tmdbMappings[0].imdb_id;
    if (!imdbId) {
      console.warn(`[ID Mapper] No IMDB ID found in TMDB mapping for ${tmdbId}`);
      return null;
    }
    
    if (!cinemetaVideos || !Array.isArray(cinemetaVideos)) {
      console.warn(`[ID Mapper] No valid Cinemeta videos array provided for ${imdbId}`);
      // Fallback: return the base IMDB ID with season/episode
      const fallbackId = `${imdbId}:${seasonNumber}:${episodeNumber}`;
      console.log(`[ID Mapper] Using fallback IMDB ID ${fallbackId} for TMDB S${seasonNumber}E${episodeNumber} (no videos data)`);
      return fallbackId;
    }
    
    // Parse the episode air date
    const targetDate = new Date(episodeAirDate);
    if (isNaN(targetDate.getTime())) {
      console.warn(`[ID Mapper] Invalid episode air date: ${episodeAirDate}`);
      // Fallback: return the base IMDB ID with season/episode
      const fallbackId = `${imdbId}:${seasonNumber}:${episodeNumber}`;
      console.log(`[ID Mapper] Using fallback IMDB ID ${fallbackId} for TMDB S${seasonNumber}E${episodeNumber} (invalid date)`);
      return fallbackId;
    }
    
    // Find the best matching episode by air date
    let bestMatch = null;
    let smallestDateDiff = Infinity;
    
    for (const video of cinemetaVideos) {
      if (!video.released || !video.season || !video.episode) continue;
      
      const videoDate = new Date(video.released);
      if (isNaN(videoDate.getTime())) continue;
      
      // Calculate date difference in days
      const dateDiff = Math.abs(targetDate.getTime() - videoDate.getTime()) / (1000 * 60 * 60 * 24);
      
      // If this is a better match (closer date), update best match
      if (dateDiff < smallestDateDiff) {
        smallestDateDiff = dateDiff;
        bestMatch = video;
      }
    }
    
    // If we found a match within 7 days, use it
    if (bestMatch && smallestDateDiff <= 7) {
      const episodeId = `${imdbId}:${bestMatch.season}:${bestMatch.episode}`;
      console.log(`[ID Mapper] Mapped TMDB S${seasonNumber}E${episodeNumber} (${episodeAirDate}) to IMDB ${episodeId} (${bestMatch.released}, diff: ${smallestDateDiff.toFixed(1)} days)`);
      return episodeId;
    }
    
    // If no close match found, try to find by season/episode number
    if (seasonNumber > 0) {
      const seasonMatch = cinemetaVideos.find(video => 
        video.season === seasonNumber && video.episode === episodeNumber
      );
      
      if (seasonMatch) {
        const episodeId = `${imdbId}:${seasonMatch.season}:${seasonMatch.episode}`;
        console.log(`[ID Mapper] Mapped TMDB S${seasonNumber}E${episodeNumber} to IMDB ${episodeId} (by season/episode number)`);
        return episodeId;
      }
    }
    
    // Fallback: return the base IMDB ID with season/episode
    const fallbackId = `${imdbId}:${seasonNumber}:${episodeNumber}`;
    console.log(`[ID Mapper] Using fallback IMDB ID ${fallbackId} for TMDB S${seasonNumber}E${episodeNumber}`);
    return fallbackId;
}

/**
 * Fetches Cinemeta videos data for an IMDB series.
 * This should be called once per IMDB series to get all episode data.
 * 
 * @param {string} imdbId - The IMDB ID of the series
 * @returns {Promise<Array|null>} Array of Cinemeta videos, or null if not found
 */
async function getCinemetaVideosForImdbSeries(imdbId) {
  if (!imdbId) {
    console.warn(`[ID Mapper] No IMDB ID provided`);
    return null;
  }
  
  try {
    // Fetch episode data from Cinemeta API
    const cinemetaUrl = `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`;
    console.log(`[ID Mapper] Fetching Cinemeta videos for IMDB ${imdbId}: ${cinemetaUrl}`);
    
    const response = await axios.get(cinemetaUrl, { timeout: 10000 });
    const cinemetaData = response.data.meta;
    
    if (!cinemetaData.videos || !Array.isArray(cinemetaData.videos)) {
      console.warn(`[ID Mapper] No videos array found in Cinemeta data for ${imdbId}`);
      return null;
    }
    
    console.log(`[ID Mapper] Successfully fetched ${cinemetaData.videos.length} videos from Cinemeta for IMDB ${imdbId}`);
    return cinemetaData.videos;
    
  } catch (error) {
    console.error(`[ID Mapper] Error fetching Cinemeta data for IMDB ${imdbId}:`, error.message);
    return null;
  }
}

function getSiblingsByImdbId(imdbId) {
  if (!isInitialized) return [];
  // IMDb IDs are strings, no need to parse.
  return imdbIdToAnimeListMap.get(imdbId) || [];
}

/**
 * Finds the corresponding IMDb ID and Season Number for a given Kitsu show ID.
 * It uses the shared IMDb ID as the franchise link.
 *
 * @param {string|number} kitsuId - The Kitsu ID of the anime season.
 * @returns {Promise<{imdbId: string, seasonNumber: number}|null>}
 */
async function resolveImdbSeasonFromKitsu(kitsuId) {
  const numericKitsuId = parseInt(kitsuId, 10);
  if (kitsuToImdbCache.has(numericKitsuId)) {
    return kitsuToImdbCache.get(numericKitsuId);
  }

  try {
    const baseMapping = getMappingByKitsuId(numericKitsuId);
    if (!baseMapping || !baseMapping.imdb_id) {
      throw new Error(`Incomplete mapping for Kitsu ID ${numericKitsuId}. Missing IMDb parent.`);
    }
    const parentImdbId = baseMapping.imdb_id;

    const siblings = getSiblingsByImdbId(parentImdbId);
    if (!siblings || siblings.length === 0) return null;

    if (siblings.length === 1) {
      const result = { imdbId: parentImdbId, seasonNumber: 1 };
      kitsuToImdbCache.set(numericKitsuId, result);
      return result;
    }

    const siblingKitsuIds = siblings.map(s => s.kitsu_id);
    const kitsuDetails = await kitsu.getMultipleAnimeDetails(siblingKitsuIds);

    const sortedKitsuSeasons = kitsuDetails
      .filter(k => k.attributes?.subtype === 'TV')
      .sort((a, b) => new Date(a.attributes.startDate) - new Date(b.attributes.startDate));

    const seasonIndex = sortedKitsuSeasons.findIndex(k => parseInt(k.id, 10) === numericKitsuId);

    if (seasonIndex !== -1) {
      const seasonNumber = seasonIndex + 1;
      const result = { imdbId: parentImdbId, seasonNumber: seasonNumber };
      console.log(`[ID Resolver] Mapped Kitsu ID ${numericKitsuId} to IMDb Season ${seasonNumber}`);
      kitsuToImdbCache.set(numericKitsuId, result);
      return result;
    }

    console.warn(`[ID Resolver] Could not determine season number for Kitsu ID ${numericKitsuId}.`);
    kitsuToImdbCache.set(numericKitsuId, null);
    return null;

  } catch (error) {
    console.error(`[ID Resolver] Error in resolveImdbSeasonFromKitsu for ${kitsuId}:`, error.message);
    return null;
  }
}



function getMappingByMalId(malId) {
  if (!isInitialized) {
    console.warn('[ID Mapper] Mapper is not initialized. Returning null.');
    return null;
  }
  return animeIdMap.get(parseInt(malId, 10)) || null;
}

function getMappingByKitsuId(kitsuId) {
  if (!isInitialized) return null;
  const numericKitsuId = parseInt(kitsuId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.kitsu_id === numericKitsuId);
  return mapping || null;
}

function getMappingByAnidbId(anidbId) {
  if (!isInitialized) return null;
  const numericAnidbId = parseInt(anidbId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.anidb_id === numericAnidbId);
  return mapping || null;
}

function getMappingByAnilistId(anilistId) {
  if (!isInitialized) return null;
  const numericAnilistId = parseInt(anilistId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.anilist_id === numericAnilistId);
  return mapping || null;
}

function getMappingByImdbId(imdbId) {
  if (!isInitialized) return null;
  const mapping = Array.from(animeIdMap.values()).find(item => item.imdb_id === imdbId);
  return mapping || null;
}

/**
 * Finds the mapping entry for a given TMDB ID.
 * This is more complex than other lookups because TMDB can have ID collisions
 * between movies and various series-like anime types (TV, OVA, ONA, etc.).
 * 
 * @param {number|string} tmdbId - The TMDB ID.
 * @param {string} type - The Stremio type ('movie' or 'series') to help disambiguate.
 * @returns {object|null} - The best matching mapping object, or null.
 */
function getMappingByTmdbId(tmdbId, type) {
  if (!isInitialized) return null;

  const numericTmdbId = parseInt(tmdbId, 10);
  
  const allMatches = tmdbIndexArray.filter(item => item.themoviedb_id === numericTmdbId);

  if (allMatches.length === 0) {
    return null;
  }
  
  if (allMatches.length === 1) {
    return allMatches[0];
  }

  console.log(`[ID Mapper] Found ${allMatches.length} potential matches for TMDB ID ${numericTmdbId}. Using type ('${type}') to find the best fit.`);

  if (type === 'movie') {
    const movieMatch = allMatches.find(item => item.type && item.type.toLowerCase() === 'movie');
    if (movieMatch) return movieMatch;
  }
  
  if (type === 'series') {
    const seriesLikeTypes = ['tv', 'ova', 'ona', 'special'];
    const seriesMatch = allMatches.find(item => item.type && seriesLikeTypes.includes(item.type.toLowerCase()));
    if (seriesMatch) return seriesMatch;
  }

  console.warn(`[ID Mapper] Could not disambiguate for TMDB ID ${numericTmdbId} with type '${type}'. Returning first available match.`);
  return allMatches[0];
}

function getAnimeTypeFromAnilistId(anilistId) {
  if (!isInitialized) return null;
  const numericAnilistId = parseInt(anilistId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.anilist_id === numericAnilistId);
  if(mapping?.type){
    const seriesLikeTypes = ['tv', 'ova', 'ona', 'special'];
    if(seriesLikeTypes.includes(mapping.type.toLowerCase())){
      return 'series';
    }else{
      return 'movie';
    }
  }
  return null;
}

function getAnimeTypeFromKitsuId(kitsuId) {
  if (!isInitialized) return null;
  const numericKitsuId = parseInt(kitsuId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.kitsu_id === numericKitsuId);
  if(mapping?.type){
    const seriesLikeTypes = ['tv', 'ova', 'ona', 'special'];
    if(seriesLikeTypes.includes(mapping.type.toLowerCase())){
      return 'series';
    }else{
      return 'movie';
    }
  }
  return null;
}

function getAnimeTypeFromMalId(malId) {
  if (!isInitialized) return null;
  const numericMalId = parseInt(malId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.mal_id === numericMalId);
  if(mapping?.type){
    const seriesLikeTypes = ['tv', 'ova', 'ona', 'special'];
    if(seriesLikeTypes.includes(mapping.type.toLowerCase())){
      return 'series';
    }else{
      return 'movie';
    }
  }
  return null;
}

function getAnimeTypeFromAnidbId(anidbId) {
  if (!isInitialized) return null;
  const numericAnidbId = parseInt(anidbId, 10);
  const mapping = Array.from(animeIdMap.values()).find(item => item.anidb_id === numericAnidbId);
  if(mapping?.type){
    const seriesLikeTypes = ['tv', 'ova', 'ona', 'special'];
    if(seriesLikeTypes.includes(mapping.type.toLowerCase())){
      return 'series';
    }else{
      return 'movie';
    }
  }
  return null;
}

function getMappingByTvdbId(tvdbId) {
  if (!isInitialized) return null;
  const numericTvdbId = parseInt(tvdbId, 10);
  const siblings = tvdbIdToAnimeListMap.get(numericTvdbId);
  return siblings?.[0] || null;
}

/**
 * Gets detailed information about the franchise mapping for a TVDB ID.
 * Useful for debugging and understanding the season structure.
 * 
 * @param {string|number} tvdbId - The TVDB ID
 * @returns {Promise<object|null>} - Franchise mapping information
 */
async function getFranchiseInfoFromTvdbId(tvdbId) {
  if (!isInitialized) return null;
  
  const franchiseMap = await buildFranchiseMapFromTvdbId(tvdbId);
  if (!franchiseMap) return null;
  
  const franchiseSiblings = tvdbIdToAnimeListMap.get(parseInt(tvdbId, 10));
  if (!franchiseSiblings) return null;
  
  const kitsuIds = franchiseSiblings.map(s => s.kitsu_id).filter(Boolean);
  const kitsuDetails = await kitsu.getMultipleAnimeDetails(kitsuIds);
  
  const seasonInfo = {};
  for (const [seasonNumber, kitsuId] of franchiseMap.entries()) {
    const kitsuItem = kitsuDetails.find(item => parseInt(item.id, 10) === kitsuId);
    if (kitsuItem) {
      seasonInfo[seasonNumber] = {
        kitsuId: kitsuId,
        title: kitsuItem.attributes?.canonicalTitle,
        subtype: kitsuItem.attributes?.subtype,
        startDate: kitsuItem.attributes?.startDate,
        episodeCount: kitsuItem.attributes?.episodeCount
      };
    }
  }
  
  return {
    tvdbId: parseInt(tvdbId, 10),
    totalSeasons: franchiseMap.size,
    seasons: seasonInfo,
    availableSeasonNumbers: Array.from(franchiseMap.keys()).sort((a, b) => a - b)
  };
}

/**
 * Gets detailed information about the franchise mapping for a TMDB ID.
 * Similar to getFranchiseInfoFromTvdbId but for TMDB-based franchises.
 * 
 * @param {string|number} tmdbId - The TMDB ID
 * @returns {Promise<object|null>} - Franchise mapping information
 */
async function getFranchiseInfoFromTmdbId(tmdbId) {
  if (!isInitialized) return null;
  
  // Find all mappings for this TMDB ID
  const tmdbMappings = Array.from(animeIdMap.values())
    .filter(mapping => mapping.themoviedb_id === tmdbId);
  
  if (tmdbMappings.length === 0) {
    console.warn(`[ID Mapper] No TMDB mapping found for TMDB ID ${tmdbId}`);
    return null;
  }
  
  try {
    // Get all Kitsu IDs from the mappings
    const kitsuIds = tmdbMappings.map(m => m.kitsu_id).filter(Boolean);
    
    if (kitsuIds.length === 0) {
      console.warn(`[ID Mapper] No valid Kitsu IDs found in TMDB mappings for ${tmdbId}`);
      return null;
    }
    
    // Fetch detailed information for all Kitsu entries
    const kitsuDetails = await kitsu.getMultipleAnimeDetails(kitsuIds);
    
    // Filter for TV series and sort by start date
    const tvSeries = kitsuDetails
      .filter(item => item.attributes?.subtype?.toLowerCase() === 'tv')
      .sort((a, b) => {
        const aDate = new Date(a.attributes?.startDate || '9999-12-31');
        const bDate = new Date(b.attributes?.startDate || '9999-12-31');
        return aDate - bDate;
      });
    
    // Filter for OVAs/ONAs and sort by start date
    const ovasAndOnas = kitsuDetails
      .filter(item => ['ova', 'ona'].includes(item.attributes?.subtype?.toLowerCase()))
      .sort((a, b) => {
        const aDate = new Date(a.attributes?.startDate || '9999-12-31');
        const bDate = new Date(b.attributes?.startDate || '9999-12-31');
        return aDate - bDate;
      });
    
    const seasonInfo = {};
    
    // Map TV series to seasons 1, 2, 3, etc.
    tvSeries.forEach((kitsuItem, index) => {
      const seasonNumber = index + 1;
      seasonInfo[seasonNumber] = {
        kitsuId: parseInt(kitsuItem.id, 10),
        title: kitsuItem.attributes?.canonicalTitle,
        subtype: kitsuItem.attributes?.subtype,
        startDate: kitsuItem.attributes?.startDate,
        episodeCount: kitsuItem.attributes?.episodeCount,
        mappingType: 'tv_series'
      };
    });
    
    // Map OVAs/ONAs to season 0
    if (ovasAndOnas.length > 0) {
      seasonInfo[0] = {
        kitsuId: parseInt(ovasAndOnas[0].id, 10),
        title: ovasAndOnas[0].attributes?.canonicalTitle,
        subtype: ovasAndOnas[0].attributes?.subtype,
        startDate: ovasAndOnas[0].attributes?.startDate,
        episodeCount: ovasAndOnas[0].attributes?.episodeCount,
        mappingType: 'ova_ona',
        allOvaIds: ovasAndOnas.map(ova => parseInt(ova.id, 10))
      };
    }
    
    const availableSeasonNumbers = Object.keys(seasonInfo).map(Number).sort((a, b) => a - b);
    
    // Determine if we need episode-level mapping
    const needsEpisodeMapping = determineIfEpisodeMappingNeeded(tvSeries.length, ovasAndOnas.length);
    
    return {
      tmdbId: parseInt(tmdbId, 10),
      totalSeasons: availableSeasonNumbers.length,
      totalKitsuIds: kitsuIds.length,
      seasons: seasonInfo,
      availableSeasonNumbers,
      mappingScenario: determineMappingScenario(tvSeries.length, ovasAndOnas.length, availableSeasonNumbers.length),
      tvSeriesCount: tvSeries.length,
      ovaCount: ovasAndOnas.length,
      needsEpisodeMapping,
      allKitsuIds: kitsuIds,
      kitsuDetails: kitsuDetails.map(item => ({
        id: parseInt(item.id, 10),
        title: item.attributes?.canonicalTitle,
        subtype: item.attributes?.subtype,
        startDate: item.attributes?.startDate,
        episodeCount: item.attributes?.episodeCount
      }))
    };
    
  } catch (error) {
    console.error(`[ID Mapper] Error getting franchise info for TMDB ${tmdbId}:`, error);
    return null;
  }
}

/**
 * Gets detailed information about the franchise mapping for a IMDb ID.
 * Similar to getFranchiseInfoFromTvdbId and getFranchiseInfoFromTmdbId but for IMDb-based franchises.
 * 
 * @param {string|number} imdbId - The IMDb ID
 * @returns {Promise<object|null>} - Franchise mapping information
 */
async function getFranchiseInfoFromImdbId(imdbId) {
  if (!isInitialized) return null;

  // Find all mappings for this IMDb ID
  const imdbMappings = imdbIdToAnimeListMap.get(imdbId) || [];
  if (imdbMappings.length === 0) {
    console.warn(`[ID Mapper] No IMDb mapping found for IMDb ID ${imdbId}`);
    return null;
  }

  try {
    // Get all Kitsu IDs from the mappings
    const kitsuIds = imdbMappings.map(m => m.kitsu_id).filter(Boolean);
    if (kitsuIds.length === 0) {
      console.warn(`[ID Mapper] No valid Kitsu IDs found in IMDb mappings for ${imdbId}`);
      return null;
    }

    // Fetch detailed information for all Kitsu entries
    const kitsuDetails = await kitsu.getMultipleAnimeDetails(kitsuIds);

    // Filter for TV series and sort by start date
    const tvSeries = kitsuDetails
      .filter(item => item.attributes?.subtype?.toLowerCase() === 'tv')
      .sort((a, b) => {
        const aDate = new Date(a.attributes?.startDate || '9999-12-31');
        const bDate = new Date(b.attributes?.startDate || '9999-12-31');
        return aDate - bDate;
      });

    // Filter for OVAs/ONAs and sort by start date
    const ovasAndOnas = kitsuDetails
      .filter(item => ['ova', 'ona'].includes(item.attributes?.subtype?.toLowerCase()))
      .sort((a, b) => {
        const aDate = new Date(a.attributes?.startDate || '9999-12-31');
        const bDate = new Date(b.attributes?.startDate || '9999-12-31');
        return aDate - bDate;
      });

    const seasonInfo = {};

    // Map TV series to seasons 1, 2, 3, etc.
    tvSeries.forEach((kitsuItem, index) => {
      const seasonNumber = index + 1;
      seasonInfo[seasonNumber] = {
        kitsuId: parseInt(kitsuItem.id, 10),
        title: kitsuItem.attributes?.canonicalTitle,
        subtype: kitsuItem.attributes?.subtype,
        startDate: kitsuItem.attributes?.startDate,
        episodeCount: kitsuItem.attributes?.episodeCount,
        mappingType: 'tv_series'
      };
    });

    // Map OVAs/ONAs to season 0
    if (ovasAndOnas.length > 0) {
      seasonInfo[0] = {
        kitsuId: parseInt(ovasAndOnas[0].id, 10),
        title: ovasAndOnas[0].attributes?.canonicalTitle,
        subtype: ovasAndOnas[0].attributes?.subtype,
        startDate: ovasAndOnas[0].attributes?.startDate,
        episodeCount: ovasAndOnas[0].attributes?.episodeCount,
        mappingType: 'ova_ona',
        allOvaIds: ovasAndOnas.map(ova => parseInt(ova.id, 10))
      };
    }

    const availableSeasonNumbers = Object.keys(seasonInfo).map(Number).sort((a, b) => a - b);

    return {
      imdbId: imdbId,
      totalSeasons: availableSeasonNumbers.length,
      seasons: seasonInfo,
      availableSeasonNumbers,
      kitsuDetails: kitsuDetails.map(item => ({
        id: parseInt(item.id, 10),
        title: item.attributes?.canonicalTitle,
        subtype: item.attributes?.subtype,
        startDate: item.attributes?.startDate,
        episodeCount: item.attributes?.episodeCount
      }))
    };
  } catch (error) {
    console.error(`[ID Mapper] Error getting franchise info for IMDb ${imdbId}:`, error);
    return null;
  }
}

/**
 * Determines if episode-level mapping is needed based on Kitsu vs TMDB season count
 */
function determineIfEpisodeMappingNeeded(tvSeriesCount, ovaCount) {
  // If we have multiple TV series, we likely need episode mapping
  // This handles cases like "Dan Da Dan" where 2 Kitsu seasons = 1 TMDB season
  return tvSeriesCount > 1;
}

/**
 * Resolves Kitsu ID and episode number for a specific episode when episode-level mapping is needed.
 * This handles cases where multiple Kitsu entries map to a single TMDB season.
 * 
 * @param {string|number} tmdbId - The TMDB ID
 * @param {number} seasonNumber - The TMDB season number
 * @param {number} episodeNumber - The episode number
 * @param {string} episodeAirDate - The episode air date (optional)
 * @returns {Promise<{kitsuId: number, episodeNumber: number}|null>} - The Kitsu ID and episode number for this specific episode
 */
async function resolveKitsuIdForEpisodeByTmdb(tmdbId, seasonNumber, episodeNumber, episodeAirDate = null) {
  if (!isInitialized) return null;
  
  const franchiseInfo = await getFranchiseInfoFromTmdbId(tmdbId);
  if (!franchiseInfo || !franchiseInfo.needsEpisodeMapping) {
    console.warn(`[ID Mapper] Episode-level mapping not needed for TMDB ${tmdbId}`);
    return null;
  }
  
  console.log(`[ID Mapper] Resolving episode-level mapping for TMDB ${tmdbId} S${seasonNumber}E${episodeNumber}`);
  
  try {
    // Get all Kitsu entries for this TMDB ID
    const kitsuEntries = franchiseInfo.kitsuDetails
      .filter(entry => entry.subtype?.toLowerCase() === 'tv')
      .sort((a, b) => new Date(a.startDate || '9999-12-31') - new Date(b.startDate || '9999-12-31'));
    
    if (kitsuEntries.length === 0) {
      console.warn(`[ID Mapper] No TV series found for episode-level mapping`);
      return null;
    }
    
    // Strategy 1: Use episode number ranges if available
    // Each Kitsu entry starts from episode 1, so we need to map TMDB episode numbers to Kitsu episode numbers
    let cumulativeEpisodes = 0;
    for (const kitsuEntry of kitsuEntries) {
      const episodeCount = kitsuEntry.episodeCount || 0;
      const startEpisode = cumulativeEpisodes + 1;
      const endEpisode = cumulativeEpisodes + episodeCount;
      
      if (episodeNumber >= startEpisode && episodeNumber <= endEpisode) {
        // Calculate the Kitsu episode number (reset to 1 for each Kitsu entry)
        const kitsuEpisodeNumber = episodeNumber - cumulativeEpisodes;
        console.log(`[ID Mapper] Episode ${episodeNumber} maps to Kitsu ID ${kitsuEntry.id} episode ${kitsuEpisodeNumber} (TMDB range ${startEpisode}-${endEpisode})`);
        return {
          kitsuId: kitsuEntry.id,
          episodeNumber: kitsuEpisodeNumber
        };
      }
      
      cumulativeEpisodes = endEpisode;
    }
    
    // Strategy 2: Use air date if available
    if (episodeAirDate) {
      const targetDate = new Date(episodeAirDate);
      if (!isNaN(targetDate.getTime())) {
        // Find the Kitsu entry that was airing around this time
        for (const kitsuEntry of kitsuEntries) {
          if (kitsuEntry.startDate) {
            const kitsuStartDate = new Date(kitsuEntry.startDate);
            const kitsuEndDate = new Date(kitsuEntry.startDate);
            kitsuEndDate.setDate(kitsuEndDate.getDate() + (kitsuEntry.episodeCount * 7)); // Rough estimate
            
            if (targetDate >= kitsuStartDate && targetDate <= kitsuEndDate) {
              console.log(`[ID Mapper] Episode ${episodeNumber} (${episodeAirDate}) maps to Kitsu ID ${kitsuEntry.id} by air date`);
              // For air date strategy, we can't determine exact episode number, so use 1 as fallback
              return {
                kitsuId: kitsuEntry.id,
                episodeNumber: 1
              };
            }
          }
        }
      }
    }
    
    // Strategy 3: Fallback to first Kitsu entry
    console.log(`[ID Mapper] Using fallback: episode ${episodeNumber} maps to first Kitsu ID ${kitsuEntries[0].id}`);
    return {
      kitsuId: kitsuEntries[0].id,
      episodeNumber: 1
    };
    
  } catch (error) {
    console.error(`[ID Mapper] Error in episode-level mapping for TMDB ${tmdbId} S${seasonNumber}E${episodeNumber}:`, error);
    return null;
  }
}

/**
 * Resolves Kitsu ID and episode number for a specific episode when episode-level mapping is needed (IMDb version).
 * This handles cases where multiple Kitsu entries map to a single IMDb season.
 * 
 * @param {string|number} imdbId - The IMDb ID
 * @param {number} seasonNumber - The IMDb season number
 * @param {number} episodeNumber - The episode number
 * @param {string} episodeAirDate - The episode air date (optional)
 * @returns {Promise<{kitsuId: number, episodeNumber: number}|null>} - The Kitsu ID and episode number for this specific episode
 */
async function resolveKitsuIdForEpisodeByImdb(imdbId, seasonNumber, episodeNumber, episodeAirDate = null) {
  if (!isInitialized) return null;
  try {
    const franchiseInfo = await getFranchiseInfoFromImdbId(imdbId);
    if (!franchiseInfo || !franchiseInfo.kitsuDetails) {
      console.warn(`[ID Mapper] [IMDb] No franchise info found for IMDb ${imdbId}`);
      return null;
    }
    // If only one TV series, no episode-level mapping needed
    const tvSeries = franchiseInfo.kitsuDetails.filter(item => item.subtype?.toLowerCase() === 'tv');
    if (tvSeries.length <= 1) {
      console.log(`[ID Mapper] [IMDb] Only one TV series for IMDb ${imdbId}, no episode-level mapping needed.`);
      return null;
    }
    // Multiple TV series: episode-level mapping needed
    let cumulativeEpisodes = 0;
    for (const kitsuEntry of tvSeries) {
      const epCount = kitsuEntry.episodeCount || 0;
      const startEp = cumulativeEpisodes + 1;
      const endEp = cumulativeEpisodes + epCount;
      if (episodeNumber >= startEp && episodeNumber <= endEp) {
        const kitsuEpisodeNumber = episodeNumber - cumulativeEpisodes;
        console.log(`[ID Mapper] [IMDb] Episode ${episodeNumber} maps to Kitsu ID ${kitsuEntry.id} episode ${kitsuEpisodeNumber} (IMDb range ${startEp}-${endEp})`);
        return { kitsuId: kitsuEntry.id, episodeNumber: kitsuEpisodeNumber };
      }
      cumulativeEpisodes = endEp;
    }
    // Fallback: try to use air date if provided
    if (episodeAirDate) {
      const targetDate = new Date(episodeAirDate);
      if (!isNaN(targetDate.getTime())) {
        for (const kitsuEntry of tvSeries) {
          if (kitsuEntry.startDate) {
            const kitsuStartDate = new Date(kitsuEntry.startDate);
            const kitsuEndDate = new Date(kitsuEntry.startDate);
            kitsuEndDate.setDate(kitsuEndDate.getDate() + (kitsuEntry.episodeCount * 7)); // Rough estimate
            if (targetDate >= kitsuStartDate && targetDate <= kitsuEndDate) {
              console.log(`[ID Mapper] [IMDb] Episode ${episodeNumber} (${episodeAirDate}) maps to Kitsu ID ${kitsuEntry.id} by air date`);
              return { kitsuId: kitsuEntry.id, episodeNumber: 1 };
            }
          }
        }
      }
    }
    // Fallback: use first TV series Kitsu entry
    if (tvSeries.length > 0) {
      console.log(`[ID Mapper] [IMDb] Fallback: episode ${episodeNumber} maps to first Kitsu ID ${tvSeries[0].id}`);
      return { kitsuId: tvSeries[0].id, episodeNumber: 1 };
    }
    return null;
  } catch (error) {
    console.error(`[ID Mapper] [IMDb] Error in resolveKitsuIdForEpisodeByImdb for IMDb ${imdbId} S${seasonNumber}E${episodeNumber}:`, error);
    return null;
  }
}

/**
 * Determines the mapping scenario for better understanding of the relationship
 */
function determineMappingScenario(tvSeriesCount, ovaCount, totalSeasons) {
  if (tvSeriesCount === 1 && ovaCount === 0) {
    return 'single_tv_series';
  } else if (tvSeriesCount === 0 && ovaCount === 1) {
    return 'single_ova';
  } else if (tvSeriesCount > 1 && ovaCount === 0) {
    return 'multiple_tv_seasons';
  } else if (tvSeriesCount === 1 && ovaCount > 0) {
    return 'tv_series_with_ovas';
  } else if (tvSeriesCount > 1 && ovaCount > 0) {
    return 'multiple_tv_seasons_with_ovas';
  } else if (tvSeriesCount === 0 && ovaCount > 1) {
    return 'multiple_ovas_only';
  } else {
    return 'complex_mapping';
  }
}

/**
 * Gets all mapping statistics and data for monitoring/debugging
 */
function getAllMappings() {
  if (!isInitialized) return null;
  
  return {
    animeIdMapSize: animeIdMap.size,
    tvdbIdMapSize: tvdbIdToAnimeListMap.size,
    imdbIdMapSize: imdbIdToAnimeListMap.size,
    tmdbIndexArraySize: tmdbIndexArray ? tmdbIndexArray.length : 0,
    animeIdMap: animeIdMap,
    tvdbIdToAnimeListMap: tvdbIdToAnimeListMap,
    imdbIdToAnimeListMap: imdbIdToAnimeListMap,
    tmdbIndexArray: tmdbIndexArray
  };
}

/**
 * Cleans up resources when the process exits
 */
function cleanup() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
    console.log('[ID Mapper] Cleaned up update interval.');
  }
}

// Register cleanup on process exit
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

module.exports = {
  initializeMapper,
  getMappingByMalId,
  getMappingByTmdbId,
  getMappingByTvdbId,
  getMappingByImdbId,
  getMappingByKitsuId,
  resolveKitsuIdFromTvdbSeason,
  resolveKitsuIdFromTmdbSeason,
  resolveKitsuIdForEpisodeByTmdb,
  resolveKitsuIdForEpisodeByImdb,
  getImdbEpisodeIdFromTmdbEpisode,
  getCinemetaVideosForImdbSeries,
  resolveImdbSeasonFromKitsu,
  getFranchiseInfoFromTvdbId,
  getFranchiseInfoFromTmdbId,
  getFranchiseInfoFromImdbId,
  getMappingByAnidbId,
  getMappingByAnilistId,
  getAnimeTypeFromAnilistId,
  getAnimeTypeFromKitsuId,
  getAnimeTypeFromMalId,
  getAnimeTypeFromAnidbId,
  getAllMappings,
  cleanup
};
