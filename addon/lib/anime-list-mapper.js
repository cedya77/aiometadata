const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const redis = require('./redisClient');
const xml2js = require('xml2js');
const consola = require('consola');


const logger = consola.withTag('AnimeListMapper');

// Anime-Lists XML file URL
const REMOTE_ANIME_LIST_URL = 'https://raw.githubusercontent.com/Anime-Lists/anime-lists/refs/heads/master/anime-list-full.xml';
const LOCAL_CACHE_PATH = path.join(process.cwd(), 'addon', 'data', 'anime-list-full.xml.cache');
const REDIS_ETAG_KEY = 'anime-list-xml-etag';
const UPDATE_INTERVAL_HOURS = parseInt(process.env.ANIME_LIST_XML_UPDATE_INTERVAL_HOURS) || 24; // Update every 24 hours (configurable)

// Data structures to hold parsed mappings
let animeListMap = new Map(); // anidbid -> anime entry
let tvdbToAnimeMap = new Map(); // tvdbid -> array of anime entries
let tmdbToAnimeMap = new Map(); // tmdbid -> array of anime entries
let imdbToAnimeMap = new Map(); // imdbid -> array of anime entries
let isInitialized = false;
let updateInterval = null;

/**
 * Parses the XML data and builds indexed maps for fast lookups
 */
function processAndIndexXmlData(xmlData) {
  animeListMap.clear();
  tvdbToAnimeMap.clear();
  tmdbToAnimeMap.clear();
  imdbToAnimeMap.clear();

  const parser = new xml2js.Parser({ explicitArray: true });
  
  return new Promise((resolve, reject) => {
    parser.parseString(xmlData, (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      try {
        const animeList = result['anime-list'].anime || [];
        
        for (const anime of animeList) {
          const anidbid = parseInt(anime.$.anidbid);
          if (!anidbid) continue;

          // Store by AniDB ID
          animeListMap.set(anidbid, anime);

          // Index by TVDB ID
          if (anime.$.tvdbid && anime.$.tvdbid !== 'unknown' && anime.$.tvdbid !== 'hentai') {
            const tvdbId = parseInt(anime.$.tvdbid);
            if (!tvdbToAnimeMap.has(tvdbId)) {
              tvdbToAnimeMap.set(tvdbId, []);
            }
            tvdbToAnimeMap.get(tvdbId).push(anime);
          }

          // Index by TMDB TV ID
          if (anime.$.tmdbtv) {
            const tmdbId = parseInt(anime.$.tmdbtv);
            if (!tmdbToAnimeMap.has(tmdbId)) {
              tmdbToAnimeMap.set(tmdbId, []);
            }
            tmdbToAnimeMap.get(tmdbId).push(anime);
          }

          // Index by IMDB ID (for movies/standalone content)
          if (anime.$.imdbid) {
            const imdbIds = anime.$.imdbid.split(',').map(id => id.trim());
            for (const imdbId of imdbIds) {
              if (imdbId && imdbId !== 'unknown') {
                if (!imdbToAnimeMap.has(imdbId)) {
                  imdbToAnimeMap.set(imdbId, []);
                }
                imdbToAnimeMap.get(imdbId).push(anime);
              }
            }
          }
        }

        isInitialized = true;
        logger.info(`Successfully loaded and indexed ${animeListMap.size} anime mappings.`);
        logger.info(`TVDB mappings: ${tvdbToAnimeMap.size}, TMDB mappings: ${tmdbToAnimeMap.size}, IMDB mappings: ${imdbToAnimeMap.size}`);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Downloads and processes the anime-list XML file.
 * It uses Redis and ETags to check if the remote file has changed,
 * avoiding a full download if the local cache is up-to-date.
 * @param {boolean} force - If true, bypass ETag check and force re-download
 */
async function downloadAndProcessAnimeList(force = false) {
  const useRedisCache = redis && redis.status === 'ready';

  try {
    if (useRedisCache && !force) {
      try {
        const savedEtag = await redis.get(REDIS_ETAG_KEY);
        const headers = (await axios.head(REMOTE_ANIME_LIST_URL, { timeout: 10000 })).headers;
        const remoteEtag = headers.etag;

        logger.debug(`Saved ETag: ${savedEtag} | Remote ETag: ${remoteEtag}`);

        if (savedEtag && remoteEtag && savedEtag === remoteEtag) {
          try {
            logger.info('No changes detected. Loading from local disk cache...');
            const fileContent = await fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
            await processAndIndexXmlData(fileContent);
            
            // Track maintenance task completion even when loading from cache
            try {
              await redis.setex('anime_list:last_update', 86400 * 7, Date.now().toString());
              logger.debug('Maintenance task tracked: anime-list loaded from cache');
            } catch (trackingError) {
              logger.warn('Failed to track maintenance task:', trackingError.message);
            }
            
            return { success: true, message: 'Loaded from cache (no changes)', count: animeListMap.size };
          } catch (e) {
            logger.warn('ETag matched, but local cache was unreadable. Forcing re-download.');
          }
        }
      } catch (redisError) {
        logger.warn('Redis error, proceeding without cache:', redisError.message);
      }
    } else if (force) {
      logger.info('Force update requested. Bypassing ETag check.');
    } else {
      logger.debug('Redis cache is disabled or unavailable. Proceeding to download.');
    }

    logger.info('Downloading anime-list XML...');
    
    // Record start time for maintenance tracking
    const startTime = Date.now();
    
    const response = await axios.get(REMOTE_ANIME_LIST_URL, { 
      timeout: 60000,
      maxRedirects: 5,
      validateStatus: function (status) {
        return status >= 200 && status < 300; // default
      }
    });
    const xmlData = response.data;

    await fs.mkdir(path.dirname(LOCAL_CACHE_PATH), { recursive: true });
    await fs.writeFile(LOCAL_CACHE_PATH, xmlData, 'utf-8');

    if (useRedisCache) {
      try {
        await redis.set(REDIS_ETAG_KEY, response.headers.etag);
      } catch (redisError) {
        logger.warn('Failed to save ETag to Redis:', redisError.message);
      }
    }

    await processAndIndexXmlData(xmlData);
    
    // Track maintenance task completion
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    if (useRedisCache) {
      try {
        await redis.setex('anime_list:last_update', 86400 * 7, startTime.toString());
        logger.info(`Maintenance task tracked: anime-list update completed in ${duration}ms`);
      } catch (trackingError) {
        logger.warn('Failed to track maintenance task:', trackingError.message);
      }
    }
    
    return { success: true, message: 'Downloaded and updated', count: animeListMap.size };

  } catch (error) {
    logger.error(`An error occurred during remote download: ${error.message}`);
    logger.info('Attempting to fall back to local disk cache...');

    try {
      const fileContent = await fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
      logger.info('Successfully loaded data from local cache on fallback.');
      await processAndIndexXmlData(fileContent);
      
      // Track maintenance task completion for fallback cache load
      if (useRedisCache) {
        try {
          await redis.setex('anime_list:last_update', 86400 * 7, Date.now().toString());
          logger.debug('Maintenance task tracked: anime-list loaded from cache (fallback)');
        } catch (trackingError) {
          logger.warn('Failed to track maintenance task:', trackingError.message);
        }
      }
      
      return { success: true, message: 'Loaded from local cache (fallback)', count: animeListMap.size };
    } catch (fallbackError) {
      logger.error('CRITICAL: Fallback to local cache also failed. Mapper will be empty.');
      return { success: false, message: `Failed to update: ${error.message}`, count: 0 };
    }
  }
}

/**
 * Initializes the anime-list mapper on addon startup.
 * It uses Redis and ETags to check if the remote file has changed,
 * avoiding a full download if the local cache is up-to-date.
 */
async function initializeAnimeListMapper() {
  if (isInitialized) return;

  await downloadAndProcessAnimeList();

  // Schedule periodic updates
  if (!updateInterval) {
    const intervalMs = UPDATE_INTERVAL_HOURS * 60 * 60 * 1000; // Convert hours to milliseconds
    updateInterval = setInterval(async () => {
      logger.info(`Running scheduled update (every ${UPDATE_INTERVAL_HOURS} hours)...`);
      try {
        await downloadAndProcessAnimeList();
        logger.info('Scheduled update completed successfully.');
      } catch (error) {
        logger.error('Scheduled update failed:', error.message);
      }
    }, intervalMs);

    logger.info(`Scheduled periodic updates every ${UPDATE_INTERVAL_HOURS} hours.`);
  }
}

/**
 * Gets anime entry by AniDB ID
 */
function getAnimeByAnidbId(anidbId) {
  if (!isInitialized) return null;
  return animeListMap.get(parseInt(anidbId)) || null;
}

/**
 * Gets anime entries by TVDB ID
 */
function getAnimeByTvdbId(tvdbId) {
  if (!isInitialized) return [];
  return tvdbToAnimeMap.get(parseInt(tvdbId)) || [];
}

/**
 * Gets anime entries by TMDB ID
 */
function getAnimeByTmdbId(tmdbId) {
  if (!isInitialized) return [];
  return tmdbToAnimeMap.get(parseInt(tmdbId)) || [];
}

/**
 * Gets anime entries by IMDB ID
 */
function getAnimeByImdbId(imdbId) {
  if (!isInitialized) return [];
  return imdbToAnimeMap.get(imdbId) || [];
}

/**
 * Gets the mapping list for a specific anime entry
 */
function getMappingList(animeEntry) {
  if (!animeEntry || !animeEntry['mapping-list']) {
    return [];
  }
  
  const mappingList = animeEntry['mapping-list'];
  
  // Handle the XML structure: mapping-list is an array with one element containing mappings
  if (Array.isArray(mappingList) && mappingList.length > 0) {
    const mappings = mappingList[0].mapping;
    if (mappings) {
      return Array.isArray(mappings) ? mappings : [mappings];
    }
  }
  
  return [];
}

/**
 * Parses episode mapping string (e.g., ";1-2;3-4;")
 */
function parseEpisodeMapping(mappingString) {
  if (!mappingString) return [];
  
  const mappings = [];
  const parts = mappingString.split(';').filter(part => part.trim());
  
  for (const part of parts) {
    const [start, end] = part.split('-').map(num => parseInt(num.trim()));
    if (!isNaN(start) && !isNaN(end)) {
      mappings.push({ start, end });
    }
  }
  
  return mappings;
}

/**
 * Gets episode mappings for a specific season
 */
function getSeasonMappings(animeEntry, anidbSeason, targetType = 'tvdb') {
  const mappingList = getMappingList(animeEntry);
  
  for (const mapping of mappingList) {
    const mappingAnidbSeason = parseInt(mapping.$.anidbseason);
    const targetSeason = parseInt(mapping.$[`${targetType}season`]);
    
    if (mappingAnidbSeason === anidbSeason) {
      return {
        targetSeason,
        episodeMappings: parseEpisodeMapping(mapping._)
      };
    }
  }
  
  return null;
}

/**
 * Resolves AniDB episode information from TVDB episode details
 * @param {number} tvdbId - The TVDB series ID
 * @param {number} tvdbSeason - The TVDB season number
 * @param {number} tvdbEpisode - The TVDB episode number within that season
 * @returns {Object|null} AniDB episode info or null if not found
 */
async function resolveAnidbEpisodeFromTvdbEpisode(tvdbId, tvdbSeason, tvdbEpisode) {
  if (!isInitialized) return null;
  
  // Get all anime entries for this TVDB ID
  const animeEntries = getAnimeByTvdbId(tvdbId);
  if (!animeEntries || animeEntries.length === 0) {
    // logger.debug(`No anime entries found for TVDB ID ${tvdbId}`);
    return null;
  }
  
  // logger.debug(`Found ${animeEntries.length} entries for TVDB ID ${tvdbId}, Season ${tvdbSeason}, Episode ${tvdbEpisode}`);
  
  // Try each anime entry to find a match
  for (const animeEntry of animeEntries) {
    const defaultTvdbSeason = animeEntry.$.defaulttvdbseason;
    const episodeOffset = parseInt(animeEntry.$.episodeoffset) || 0;
    
    // logger.debug(`Processing entry anidbid=${animeEntry.$.anidbid}, defaulttvdbseason="${defaultTvdbSeason}", episodeoffset=${episodeOffset}`);
    
    // Case 1: Absolute episode numbering (defaulttvdbseason = "a")
    if (defaultTvdbSeason === 'a') {
      // logger.debug(`Case 1: Absolute numbering`);
      const result = handleAbsoluteNumbering(animeEntry, tvdbSeason, tvdbEpisode);
      if (result) return result;
    }
    
    // Case 2: Multi-season with absolute numbering (defaulttvdbseason = "0")
    else if (defaultTvdbSeason === '0') {
      // logger.debug(`Case 2: Multi-season, skipping`);
      // Skip this entry - it's part of a multi-episode series but doesn't map to a specific season
      continue; // Try the next anime entry
    }
    
    // Case 3: Regular season mapping (defaulttvdbseason = specific number)
    else {
      const defaultSeason = parseInt(defaultTvdbSeason);
      // logger.debug(`Case 3: Regular season mapping, defaultSeason=${defaultSeason}, tvdbSeason=${tvdbSeason}`);
      if (defaultSeason === tvdbSeason) {
        // logger.debug(`Season match! Calling handleRegularSeasonMapping`);
        const result = handleRegularSeasonMapping(animeEntry, tvdbSeason, tvdbEpisode, episodeOffset);
        if (result) {
          // logger.debug(`Success! Result:`, result);
          return result;
        } else {
          // logger.debug(`handleRegularSeasonMapping returned null, continuing to next entry...`);
        }
      } else {
        // logger.debug(`Season mismatch: defaultSeason=${defaultSeason} !== tvdbSeason=${tvdbSeason}`);
      }
    }
  }
  
  // logger.debug(`No matching season found for TVDB ID ${tvdbId}, Season ${tvdbSeason}`);
  return null;
}

/**
 * Handle absolute episode numbering (like One Piece)
 */
function handleAbsoluteNumbering(animeEntry, tvdbSeason, tvdbEpisode) {
  const mappingList = getMappingList(animeEntry);
  
  // Find the season-specific mapping
  for (const mapping of mappingList) {
    const mappingTvdbSeason = parseInt(mapping.$.tvdbseason);
    if (mappingTvdbSeason === tvdbSeason) {
      const offset = parseInt(mapping.$.offset) || 0; // Default to 0 if no offset
      // Check if this mapping has start/end range
      if (mapping.$.start && mapping.$.end) {
        const anidbStart = parseInt(mapping.$.start);
        const anidbEnd = parseInt(mapping.$.end);
       
        
        // Calculate the AniDB episode for this TVDB episode
        const anidbEpisode = tvdbEpisode - offset;
        
        // Check if the calculated AniDB episode falls within the mapped range
        if (anidbEpisode >= anidbStart && anidbEpisode <= anidbEnd) {
          
          return {
            anidbId: parseInt(animeEntry.$.anidbid),
            anidbSeason: parseInt(mapping.$.anidbseason),
            anidbEpisode: anidbEpisode,
            episodeOffset: offset,
            animeName: animeEntry.name,
            mappingInfo: {
              type: 'absolute_numbering',
              start: anidbStart,
              end: anidbEnd,
              offset: offset
            }
          };
        }
      }
      else if (mapping.$.start && !mapping.$.end) {
        const anidbStart = parseInt(mapping.$.start);
        const anidbEpisode = tvdbEpisode - offset;

        if (anidbEpisode >= anidbStart) {
          return {
            anidbId: parseInt(animeEntry.$.anidbid),
            anidbSeason: parseInt(mapping.$.anidbseason),
            anidbEpisode: anidbEpisode,
            episodeOffset: offset,
            animeName: animeEntry.name,
            mappingInfo: {
              type: 'absolute_numbering_open',
              start: anidbStart,
              offset: offset
            }
          };
        }
      }
      // TODO: Handle episode mapping strings (like ";1-2;3-4;") for cases without start/end
    }
  }
  
  return null;
}

/**
 * Handle regular season mapping with episode offset
 */
function handleRegularSeasonMapping(animeEntry, tvdbSeason, tvdbEpisode, episodeOffset) {
  // logger.debug(`Starting with tvdbSeason=${tvdbSeason}, tvdbEpisode=${tvdbEpisode}, episodeOffset=${episodeOffset}`);
  
  // Check if there are multiple entries with the same tvdbId and defaulttvdbseason
  const allEntries = getAnimeByTvdbId(animeEntry.$.tvdbid);
  const sameSeasonEntries = allEntries.filter(entry => 
    entry.$.defaulttvdbseason === animeEntry.$.defaulttvdbseason
  );
  
  // logger.debug(`Found ${sameSeasonEntries.length} entries with same defaulttvdbseason`);
  
  // If there's only one entry for this season, use direct 1:1 mapping
  if (sameSeasonEntries.length === 1) {
    // logger.debug(`Single entry case - direct 1:1 mapping`);
    // Direct 1:1 mapping - ignore mapping-list
    const anidbEpisode = tvdbEpisode - episodeOffset;
    
    // logger.debug(`Calculated anidbEpisode = ${tvdbEpisode} - ${episodeOffset} = ${anidbEpisode}`);
    
    // Check if the calculated AniDB episode is valid (positive)
    if (anidbEpisode <= 0) {
      // logger.debug(`Invalid anidbEpisode (${anidbEpisode}), returning null`);
      return null;
    }
    
    const result = {
      anidbId: parseInt(animeEntry.$.anidbid),
      anidbSeason: 1, // Usually season 1 for these cases
      anidbEpisode: anidbEpisode,
      episodeOffset: episodeOffset,
      animeName: animeEntry.name,
      mappingInfo: {
        type: 'regular_season_direct',
        episodeOffset: episodeOffset
      }
    };
    
    // logger.debug(`Returning result:`, result);
    return result;
  }
  
  // Multiple entries for this season, use mapping-list ranges
  // logger.debug(`Multiple entries case - checking mapping-list`);
  const mappingList = getMappingList(animeEntry);
  // logger.debug(`mappingList length: ${mappingList.length}`);
  
  if (mappingList.length > 0) {
    // logger.debug(`Processing mapping-list entries`);
    // Check if there's a mapping that covers this episode
    for (const mapping of mappingList) {
      // logger.debug(`Checking mapping:`, mapping);
      if (mapping.$.start && mapping.$.end) {
        const start = parseInt(mapping.$.start);
        const end = parseInt(mapping.$.end);
        
        // logger.debug(`Mapping has start=${start}, end=${end}`);
        
        // Check if this TVDB episode falls within the mapped range
        if (tvdbEpisode >= start + episodeOffset && tvdbEpisode <= end + episodeOffset) {
          // logger.debug(`Episode ${tvdbEpisode} falls within range [${start + episodeOffset}, ${end + episodeOffset}]`);
          // Calculate AniDB episode using episodeoffset
          const anidbEpisode = tvdbEpisode - episodeOffset;
          
          // logger.debug(`Calculated anidbEpisode = ${tvdbEpisode} - ${episodeOffset} = ${anidbEpisode}`);
          
          // Check if the calculated AniDB episode is valid (positive)
          if (anidbEpisode <= 0) {
            // logger.debug(`Invalid anidbEpisode (${anidbEpisode}), returning null`);
            return null;
          }
          
          const result = {
            anidbId: parseInt(animeEntry.$.anidbid),
            anidbSeason: parseInt(mapping.$.anidbseason),
            anidbEpisode: anidbEpisode,
            episodeOffset: episodeOffset,
            animeName: animeEntry.name,
            mappingInfo: {
              type: 'regular_season_with_mapping',
              start: start,
              end: end,
              episodeOffset: episodeOffset
            }
          };
          
          // logger.debug(`Returning result:`, result);
          return result;
        } else {
          // logger.debug(`Episode ${tvdbEpisode} does NOT fall within range [${start + episodeOffset}, ${end + episodeOffset}]`);
        }
      } else {
        // logger.debug(`Mapping missing start/end attributes - will fall back to episodeOffset approach`);
      }
    }
    // If we have mappings but none cover this episode, this entry doesn't match
    // logger.debug(`No mapping covered this episode, will fall back to episodeOffset approach`);
  }
  
  // No specific mappings or mappings without start/end, use the episodeOffset approach
  // logger.debug(`Using episodeOffset fallback`);
  
  // For multiple entries with same season, we need to implement episode range logic
  // Check if this entry should handle this specific episode based on episodeOffset
  if (sameSeasonEntries.length > 1) {
    // logger.debug(`Multiple entries detected, implementing episode range logic`);
    
    // Find the next entry with a higher episodeOffset to determine the range
    const sortedEntries = sameSeasonEntries.sort((a, b) => {
      const offsetA = parseInt(a.$.episodeoffset) || 0;
      const offsetB = parseInt(b.$.episodeoffset) || 0;
      return offsetA - offsetB;
    });
    
    const currentEntryIndex = sortedEntries.findIndex(entry => 
      parseInt(entry.$.anidbid) === parseInt(animeEntry.$.anidbid)
    );
    
    if (currentEntryIndex >= 0) {
      const currentOffset = parseInt(animeEntry.$.episodeoffset) || 0;
      const nextEntry = sortedEntries[currentEntryIndex + 1];
      
      if (nextEntry) {
        const nextOffset = parseInt(nextEntry.$.episodeoffset) || 0;
        // logger.debug(`Current entry offset: ${currentOffset}, Next entry offset: ${nextOffset}`);
        
        // This entry should handle episodes from currentOffset to nextOffset-1
        // currentOffset is inclusive, nextOffset is exclusive
        if (tvdbEpisode > nextOffset) {
          // logger.debug(`Episode ${tvdbEpisode} >= ${nextOffset}, this entry doesn't cover it`);
          return null;
        }
        
        // logger.debug(`Episode ${tvdbEpisode} is within range [${currentOffset}, ${nextOffset-1}]`);
      }
    }
  }
  
  // Formula: anidbEpisode = tvdbEpisode - episodeOffset
  const anidbEpisode = tvdbEpisode - episodeOffset;
  
  // logger.debug(`Calculated anidbEpisode = ${tvdbEpisode} - ${episodeOffset} = ${anidbEpisode}`);
  
  // Check if the calculated AniDB episode is valid (positive)
  if (anidbEpisode <= 0) {
    // logger.debug(`Invalid anidbEpisode (${anidbEpisode}), returning null`);
    return null; // This anime entry doesn't cover this TVDB episode
  }
  
  const result = {
    anidbId: parseInt(animeEntry.$.anidbid),
    anidbSeason: 1, // Usually season 1 for these cases
    anidbEpisode: anidbEpisode,
    episodeOffset: episodeOffset,
    animeName: animeEntry.name,
    mappingInfo: {
      type: 'regular_season',
      episodeOffset: episodeOffset
    }
  };
  
  // logger.debug(`Returning fallback result:`, result);
  return result;
}

/**
 * Resolves TVDB episode details from AniDB identifiers
 * @param {number} anidbId - AniDB series ID
 * @param {number} anidbSeason - AniDB season number
 * @param {number} anidbEpisode - AniDB episode number
 * @returns {Object|null} TVDB episode info or null if not found
 */
function resolveTvdbEpisodeFromAnidbEpisode(anidbId, anidbSeason, anidbEpisode) {
  if (!isInitialized) return null;

  const animeEntry = getAnimeByAnidbId(anidbId);
  if (!animeEntry) {
    // logger.debug(`No anime entry found for AniDB ID ${anidbId}`);
    return null;
  }

  const tvdbId = animeEntry.$.tvdbid ? parseInt(animeEntry.$.tvdbid) : null;
  if (!tvdbId) {
    // logger.debug(`AniDB ID ${anidbId} does not have a TVDB mapping`);
    return null;
  }

  const defaultTvdbSeason = animeEntry.$.defaulttvdbseason;
  const episodeOffset = parseInt(animeEntry.$.episodeoffset) || 0;
  const mappingList = getMappingList(animeEntry);

  const buildResult = (season, episode, info) => ({
    tvdbId,
    tvdbSeason: season,
    tvdbEpisode: episode,
    animeName: animeEntry.name,
    mappingInfo: info,
  });

  if (defaultTvdbSeason === 'a') {
    for (const mapping of mappingList) {
      const mappingAnidbSeason = parseInt(mapping.$.anidbseason);
      if (mappingAnidbSeason !== anidbSeason) continue;

      if (mapping.$.tvdbseason === undefined) continue;
      const tvdbSeason = parseInt(mapping.$.tvdbseason);
      const offset = parseInt(mapping.$.offset) || 0;

      if (mapping.$.start && mapping.$.end) {
        const start = parseInt(mapping.$.start);
        const end = parseInt(mapping.$.end);

        if (anidbEpisode >= start && anidbEpisode <= end) {
          const tvdbEpisode = anidbEpisode + offset;
          return buildResult(tvdbSeason, tvdbEpisode, {
            type: 'absolute_numbering',
            start,
            end,
            offset,
          });
        }
      } else if (mapping.$.start && !mapping.$.end) {
        const start = parseInt(mapping.$.start);
        if (anidbEpisode >= start) {
           const tvdbEpisode = anidbEpisode + offset;
           return buildResult(tvdbSeason, tvdbEpisode, {
             type: 'absolute_numbering_open',
             start,
             offset,
           });
        }
     } else if (mapping._) {
        const ranges = parseEpisodeMapping(mapping._);
        for (const range of ranges) {
          if (anidbEpisode >= range.start && anidbEpisode <= range.end) {
            const tvdbEpisode = anidbEpisode + offset;
            return buildResult(tvdbSeason, tvdbEpisode, {
              type: 'absolute_numbering_range',
              range,
              offset,
            });
          }
        }
      }
    }

    // logger.debug(
    //   `No absolute mapping found for AniDB ${anidbId} S${anidbSeason}E${anidbEpisode}`
    // );
    return null;
  }

  if (defaultTvdbSeason === '0') {
    // logger.debug(
    //   `defaulttvdbseason=0 currently unsupported for reverse lookup (AniDB ${anidbId})`
    // );
    return null;
  }

  const tvdbSeason = parseInt(defaultTvdbSeason);
  const allEntries = getAnimeByTvdbId(animeEntry.$.tvdbid);
  const sameSeasonEntries = allEntries.filter(
    (entry) => entry.$.defaulttvdbseason === animeEntry.$.defaulttvdbseason
  );

  if (sameSeasonEntries.length === 1) {
    const tvdbEpisode = anidbEpisode + episodeOffset;
    if (tvdbEpisode <= 0) {
      // logger.debug(
      //   `Calculated TVDB episode <= 0 for AniDB ${anidbId} S${anidbSeason}E${anidbEpisode}`
      // );
      return null;
    }

    return buildResult(tvdbSeason, tvdbEpisode, {
      type: 'regular_season_direct',
      episodeOffset,
    });
  }

  for (const mapping of mappingList) {
    const mappingAnidbSeason = parseInt(mapping.$.anidbseason);
    if (mappingAnidbSeason !== anidbSeason) continue;

    const targetSeason = parseInt(mapping.$.tvdbseason) || tvdbSeason;
    const offset = parseInt(mapping.$.offset) || episodeOffset;

    if (mapping.$.start && mapping.$.end) {
      const start = parseInt(mapping.$.start);
      const end = parseInt(mapping.$.end);

      if (anidbEpisode >= start && anidbEpisode <= end) {
        const delta = anidbEpisode - start;
        const tvdbEpisode = start + offset + delta;
        return buildResult(targetSeason, tvdbEpisode, {
          type: 'regular_season_with_mapping',
          start,
          end,
          offset,
        });
      }
    }
  }

  if (sameSeasonEntries.length > 1) {
    const sortedEntries = sameSeasonEntries
      .map((entry) => ({
        entry,
        offset: parseInt(entry.$.episodeoffset) || 0,
      }))
      .sort((a, b) => a.offset - b.offset);

    const currentIndex = sortedEntries.findIndex(
      (item) => parseInt(item.entry.$.anidbid) === parseInt(animeEntry.$.anidbid)
    );

    if (currentIndex >= 0) {
      const currentOffset = sortedEntries[currentIndex].offset;
      const nextOffset = sortedEntries[currentIndex + 1]?.offset;

      if (anidbEpisode < 1) {
        // logger.debug(
        //   `AniDB episode must be >= 1 (AniDB ${anidbId} S${anidbSeason}E${anidbEpisode})`
        // );
        return null;
      }

      if (nextOffset !== undefined && anidbEpisode >= nextOffset) {
        // logger.debug(
        //   `AniDB episode ${anidbEpisode} falls beyond range for this entry (next offset ${nextOffset})`
        // );
        return null;
      }

      const tvdbEpisode = anidbEpisode + currentOffset;
      if (tvdbEpisode <= 0) {
        return null;
      }

      return buildResult(tvdbSeason, tvdbEpisode, {
        type: 'regular_season_offset_range',
        episodeOffset: currentOffset,
        nextOffset,
      });
    }
  }

  const tvdbEpisode = anidbEpisode + episodeOffset;
  if (tvdbEpisode <= 0) {
    // logger.debug(
    //   `Calculated TVDB episode <= 0 for AniDB ${anidbId} S${anidbSeason}E${anidbEpisode}`
    // );
    return null;
  }

  return buildResult(tvdbSeason, tvdbEpisode, {
    type: 'regular_season_fallback',
    episodeOffset,
  });
}

module.exports = {
  initializeAnimeListMapper,
  getAnimeByAnidbId,
  getAnimeByTvdbId,
  getAnimeByTmdbId,
  getAnimeByImdbId,
  getMappingList,
  parseEpisodeMapping,
  getSeasonMappings,
  resolveAnidbEpisodeFromTvdbEpisode,
  resolveTvdbEpisodeFromAnidbEpisode,
  forceUpdateAnimeListXml,
  getAnimeListXmlStats,
  isInitialized: () => isInitialized,
  // Debug exports
  tvdbToAnimeMap: () => tvdbToAnimeMap,
  animeListMap: () => animeListMap
};

/**
 * Force update the anime-list XML mapping
 * @returns {Promise<Object>} Result object with success, message, and count
 */
async function forceUpdateAnimeListXml() {
  logger.info('Force update requested for anime-list XML...');
  try {
    const result = await downloadAndProcessAnimeList(true);
    return result;
  } catch (error) {
    logger.error('Force update failed:', error.message);
    return { success: false, message: `Force update failed: ${error.message}`, count: animeListMap.size };
  }
}

/**
 * Get stats for the anime-list XML mapper (for dashboard display)
 * @returns {Object} Stats object with counts, updateInterval, and initialized status
 */
function getAnimeListXmlStats() {
  return {
    count: animeListMap.size,
    tvdbMappings: tvdbToAnimeMap.size,
    tmdbMappings: tmdbToAnimeMap.size,
    imdbMappings: imdbToAnimeMap.size,
    updateIntervalHours: UPDATE_INTERVAL_HOURS,
    initialized: isInitialized
  };
}
