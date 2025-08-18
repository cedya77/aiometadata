const { decompressFromEncodedURIComponent } = require('lz-string');
const axios = require('axios');
const fanart = require('./fanart');
const anilist = require('../lib/anilist');
const tvdb = require('../lib/tvdb');
const tmdb = require('../lib/getTmdb');

const idMapper = require('../lib/id-mapper');

const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

function sortSearchResults(results, query) {
  const lowerCaseQuery = query.toLowerCase();
  results.sort((a, b) => {
    const titleA = (a.name || '').toLowerCase();
    const titleB = (b.name || '').toLowerCase();
    if (titleA === lowerCaseQuery && titleB !== lowerCaseQuery) return -1;
    if (titleA !== lowerCaseQuery && titleB === lowerCaseQuery) return 1;
    const startsWithA = titleA.startsWith(lowerCaseQuery);
    const startsWithB = titleB.startsWith(lowerCaseQuery);
    if (startsWithA && !startsWithB) return -1;
    if (!startsWithA && startsWithB) return 1;
    const scoreA = a.popularity || a.score || 0;
    const scoreB = b.popularity || b.score || 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    const yearA = parseInt(a.year, 10) || 0;
    const yearB = parseInt(b.year, 10) || 0;
    if (yearA !== yearB) return yearB - yearA;
    return 0;
  });
  return results;
}

function parseMedia(el, type, genreList = []) {
  const genres = Array.isArray(el.genre_ids)
    ? el.genre_ids.map(genreId => (genreList.find((g) => g.id === genreId) || {}).name).filter(Boolean)
    : [];

  return {
    id: `tmdb:${el.id}`,
    name: type === 'movie' ? el.title : el.name,
    genre: genres,
    poster: el.poster_path ? `https://image.tmdb.org/t/p/w500${el.poster_path}` : null,
    background: el.backdrop_path ? `https://image.tmdb.org/t/p/original${el.backdrop_path}` : null,
    posterShape: "regular",
    imdbRating: el.vote_average ? el.vote_average.toFixed(1) : 'N/A',
    year: type === 'movie' ? (el.release_date?.substring(0, 4) || '') : (el.first_air_date?.substring(0, 4) || ''),
    type: type === 'movie' ? type : 'series',
    description: el.overview,
  };
}


function parseCast(credits, count) {
  if (!credits || !Array.isArray(credits.cast)) return [];
  const cast = credits.cast;
  const toParse = count === undefined || count === null ? cast : cast.slice(0, count);

  return toParse.map((el) => {
    let photoUrl = null;
    if (el.profile_path) {
      if (el.profile_path.startsWith('http')) {
        photoUrl = el.profile_path;
      } else {
        photoUrl = `https://image.tmdb.org/t/p/w276_and_h350_face${el.profile_path}`;
      }
    }
    return {
      name: el.name,
      character: el.character,
      photo: photoUrl
    };
  });
}

function parseDirector(credits) {
  if (!credits || !Array.isArray(credits.crew)) return [];
  return credits.crew.filter((x) => x.job === "Director").map((el) => el.name);
}

function parseWriter(credits) {
    if (!credits || !Array.isArray(credits.crew)) return [];
    const writers = credits.crew.filter((x) => x.department === "Writing").map((el) => el.name);
    const creators = credits.crew.filter((x) => x.job === "Creator").map((el) => el.name);
    return [...new Set([...writers, ...creators])];
}

function parseSlug(type, title, imdbId, uniqueIdFallback = null) {
  const safeTitle = (title || '')
    .toLowerCase()
    .replace(/ /g, "-");

  let identifier = '';
  if (imdbId) {
    identifier = imdbId.replace('tt', '');
  } else if (uniqueIdFallback) {
    identifier = String(uniqueIdFallback);
  }

  return identifier ? `${type}/${safeTitle}-${identifier}` : `${type}/${safeTitle}`;
}

function parseTrailers(videos) {
    if (!videos || !Array.isArray(videos.results)) return [];
    return videos.results
        .filter((el) => el.site === "YouTube" && el.type === "Trailer")
        .map((el) => ({ source: el.key, type: el.type, name: el.name, ytId: el.key }));
}

function parseTrailerStream(videos) {
    if (!videos || !Array.isArray(videos.results)) return [];
    return videos.results
        .filter((el) => el.site === "YouTube" && el.type === "Trailer")
        .map((el) => ({ title: el.name, ytId: el.key }));
}

function parseImdbLink(vote_average, imdb_id) {
  return {
    name: vote_average,
    category: "imdb",
    url: `https://imdb.com/title/${imdb_id}`,
  };
}

function parseShareLink(title, imdb_id, type) {
  return {
    name: "Share",
    category: "share",
    url: `https://www.strem.io/s/${type}/${imdb_id}/${encodeURIComponent(title)}`,
  };
}

function parseAnimeGenreLink(genres, type, configString) {
  if (!Array.isArray(genres) || !process.env.HOST_NAME) return [];
  
  // Extract userUUID and compressedConfig from configString if it contains both
  let userUUID = null;
  let compressedConfig = configString;
  
  // Check if configString contains both userUUID and compressed config (format: userUUID/compressedConfig)
  if (configString && configString.includes('/')) {
    const parts = configString.split('/');
    if (parts.length >= 2) {
      userUUID = parts[0];
      compressedConfig = parts.slice(1).join('/');
    }
  }
  
  const manifestPath = userUUID && compressedConfig 
    ? `stremio/${userUUID}/${compressedConfig}/manifest.json` 
    : configString ? `${configString}/manifest.json` : 'manifest.json';
  const manifestUrl = `${host}/${manifestPath}`;  

  return genres.map((genre) => {
    if (!genre || !genre.name) return null;

    let searchUrl;
    const genreId = genre.mal_id;
    if (!genreId) return null;
    let url = `stremio:///discover/${encodeURIComponent(
      manifestUrl
    )}/anime/mal.genres?genre=${genre.name}`;
    if (type === 'movie') {
      url += `&type_filter=movie`;
    } else if (type === 'series') {
      url += `&type_filter=tv`;
    }
    searchUrl = url;

    return {
      name: genre.name,
      category: "Genres",
      url: searchUrl,
    };
  }).filter(Boolean);
}

function parseGenreLink(genres, type, configString, isTvdb = false) {
  if (!Array.isArray(genres) || !process.env.HOST_NAME) return [];
  
  const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;
    
  // Extract userUUID and compressedConfig from configString if it contains both
  let userUUID = null;
  let compressedConfig = configString;
  
  // Check if configString contains both userUUID and compressed config (format: userUUID/compressedConfig)
  if (configString && configString.includes('/')) {
    const parts = configString.split('/');
    if (parts.length >= 2) {
      userUUID = parts[0];
      compressedConfig = parts.slice(1).join('/');
    }
  }
  
  const manifestPath = userUUID && compressedConfig 
    ? `stremio/${userUUID}/${compressedConfig}/manifest.json` 
    : configString ? `${configString}/manifest.json` : 'manifest.json';
  const manifestUrl = `${host}/${manifestPath}`;

  return genres.map((genre) => {
    if (!genre || !genre.name) return null;

    let searchUrl;
    if (isTvdb) {
      searchUrl = `stremio:///discover/${encodeURIComponent(
        manifestUrl
      )}/${type}/tvdb.genres?genre=${encodeURIComponent(
        genre.name
      )}`;
    } else {
      searchUrl = `stremio:///discover/${encodeURIComponent(
        manifestUrl
      )}/${type}/tmdb.top?genre=${encodeURIComponent(
        genre.name
      )}`;
    }

    return {
      name: genre.name,
      category: "Genres",
      url: searchUrl,
    };
  }).filter(Boolean);
}

function parseCreditsLink(credits, castCount) {
  const castData = parseCast(credits, castCount);
  const Cast = castData.map((actor) => ({
    name: actor.name, category: "Cast", url: `stremio:///search?search=${encodeURIComponent(actor.name)}`
  }));
  const Director = parseDirector(credits).map((director) => ({
    name: director, category: "Directors", url: `stremio:///search?search=${encodeURIComponent(director)}`,
  }));
  const Writer = parseWriter(credits).map((writer) => ({
    name: writer, category: "Writers", url: `stremio:///search?search=${encodeURIComponent(writer)}`,
  }));
  return [...Cast, ...Director, ...Writer];
}



function buildLinks(imdbRating, imdbId, title, type, genres, credits, language, castCount, catalogChoices, isTvdb = false) {
  const links = [];

  if (imdbId) {
    links.push(parseImdbLink(imdbRating, imdbId));
    links.push(parseShareLink(title, imdbId, type));
  }

  const genreLinks = parseGenreLink(genres, type, catalogChoices, isTvdb);
  if (genreLinks.length > 0) {
    links.push(...genreLinks);
  }

  const creditLinks = parseCreditsLink(credits, castCount);
  if (creditLinks.length > 0) {
    links.push(...creditLinks);
  }
  return links.filter(Boolean);
}


function parseCoutry(production_countries) {
  return production_countries?.map((country) => country.name).join(", ") || '';
}

function parseGenres(genres) {
  return genres?.map((el) => el.name) || [];
}

function parseYear(status, first_air_date, last_air_date) {
  const startYear = first_air_date ? first_air_date.substring(0, 4) : '';
  if (status === "Ended" && last_air_date) {
    const endYear = last_air_date.substring(0, 4);
    return startYear === endYear ? startYear : `${startYear}-${endYear}`;
  }
  return startYear;
}


function parseAnimeCreditsLink(characterData, configString, castCount) {
  if (!characterData || !characterData.length === 0) return [];

  const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;
    
  // Extract userUUID and compressedConfig from configString if it contains both
  let userUUID = null;
  let compressedConfig = configString;
  
  // Check if configString contains both userUUID and compressed config (format: userUUID/compressedConfig)
  if (configString && configString.includes('/')) {
    const parts = configString.split('/');
    if (parts.length >= 2) {
      userUUID = parts[0];
      compressedConfig = parts.slice(1).join('/');
    }
  }
  
  const manifestPath = userUUID && compressedConfig 
    ? `stremio/${userUUID}/${compressedConfig}/manifest.json` 
    : configString ? `${configString}/manifest.json` : 'manifest.json';
  const manifestUrl = `${host}/${manifestPath}`;

  const voiceActorLinks = characterData.slice(0, castCount).map(charEntry => {
    const voiceActor = charEntry.voice_actors.find(va => va.language === 'Japanese');
    if (!voiceActor) return null;

    const vaMalId = voiceActor.person.mal_id;

    const searchUrl = `stremio:///discover/${encodeURIComponent(
      manifestUrl
    )}/anime/mal.va_search?va_id=${vaMalId}`;

    return {
      name: voiceActor.person.name,
      category: 'Cast',
      url: searchUrl
    };
  }).filter(Boolean);

  return [...voiceActorLinks];
}


function parseAnimeRelationsLink(relationsData, type, configString) {
  if (!Array.isArray(relationsData) || relationsData.length === 0) {
    return [];
  }

  // Extract userUUID and compressedConfig from configString if it contains both
  let userUUID = null;
  let compressedConfig = configString;
  
  // Check if configString contains both userUUID and compressed config (format: userUUID/compressedConfig)
  if (configString && configString.includes('/')) {
    const parts = configString.split('/');
    if (parts.length >= 2) {
      userUUID = parts[0];
      compressedConfig = parts.slice(1).join('/');
    }
  }

  const relationLinks = relationsData.flatMap(relation => {
    const relationType = relation.relation;
    if (relationType !== 'Prequel' && relationType !== 'Sequel') {
      return [];
    }

    return (relation.entry || []).map(entry => {
      if (!entry.mal_id || !entry.name) return null;

      // Construct meta URL with proper UUID route if available
      let metaUrl;
      if (userUUID && compressedConfig) {
        const host = process.env.HOST_NAME.startsWith('http')
          ? process.env.HOST_NAME
          : `https://${process.env.HOST_NAME}`;
        metaUrl = `${host}/stremio/${userUUID}/${compressedConfig}/meta/${type}/mal:${entry.mal_id}.json`;
      } else {
        metaUrl = `stremio:///detail/${type}/mal:${entry.mal_id}`;
      }

      return {
        name: entry.name,
        category: relationType,
        url: metaUrl
      };
    }).filter(Boolean);
  });

  return relationLinks;
}


async function getAnimeGenres() {
  const url = `${JIKAN_API_BASE}/genres/anime`;
  return enqueueRequest(() => _makeJikanRequest(url), url)
    .then(response => response.data?.data || [])
    .catch(e => {
      console.error(`Could not fetch anime genres from Jikan`, e.message);
      return [];
    });
}



function parseRunTime(runtime) {
  if (!runtime) return "";

  let totalMinutes;

  if (typeof runtime === 'number') {
    totalMinutes = runtime;
  }
  else if (typeof runtime === 'string') {
    let hours = 0;
    let minutes = 0;

    const hourMatch = runtime.match(/(\d+)\s*hr?/);
    if (hourMatch) {
      hours = parseInt(hourMatch[1], 10);
    }

    const minuteMatch = runtime.match(/(\d+)\s*min?/);
    if (minuteMatch) {
      minutes = parseInt(minuteMatch[1], 10);
    }
    if (hours === 0 && minutes === 0) {
      totalMinutes = parseInt(runtime, 10);
    } else {
      totalMinutes = (hours * 60) + minutes;
    }

  } else {
    return "";
  }

  if (isNaN(totalMinutes) || totalMinutes <= 0) {
    return "";
  }

  const finalHours = Math.floor(totalMinutes / 60);
  const finalMinutes = totalMinutes % 60;

  if (finalHours > 0) {
    const hourString = `${finalHours}h`;
    const minuteString = finalMinutes > 0 ? `${finalMinutes}min` : '';
    return `${hourString}${minuteString}`;
  } else {
    return `${finalMinutes}min`;
  }
}

function parseCreatedBy(created_by) {
  return created_by?.map((el) => el.name).join(', ') || '';
}

function parseConfig(catalogChoices) {
  if (!catalogChoices) return {};
  try {
    const config = JSON.parse(decompressFromEncodedURIComponent(catalogChoices));
    
    // Debug: Log art provider configuration
    if (config.artProviders) {
      console.log(`[Config Debug] Art providers:`, config.artProviders);
    }
    
    return config;
  } catch (e) {
    try { 
      const config = JSON.parse(catalogChoices);
      
      // Debug: Log art provider configuration
      if (config.artProviders) {
        console.log(`[Config Debug] Art providers:`, config.artProviders);
      }
      
      return config; 
    } catch { return {}; }
  }
}

function getRpdbPoster(type, ids, language, rpdbkey) {
    const tier = rpdbkey.split("-")[0]
    const lang = language.split("-")[0]
    const { tmdbId, tvdbId } = ids;
    let baseUrl = `https://api.ratingposterdb.com`;
    let idType = null;
    let fullMediaId = null;
    if (type === 'movie') {
        if (tvdbId) {
            idType = 'tvdb';
            fullMediaId = tvdbId;
        } else if (tmdbId) {
            idType = 'tmdb';
            fullMediaId = `movie-${tmdbId}`;
        } else if (ids.imdbId) {
            idType = 'imdb';
            fullMediaId = ids.imdbId;
        }
    } else if (type === 'series') {
        if (tvdbId) {
            idType = 'tvdb';
            fullMediaId = tvdbId;
        } else if (tmdbId) {
            idType = 'tmdb';
            fullMediaId = `series-${tmdbId}`;
        } else if (ids.imdbId) {
            idType = 'imdb';
            fullMediaId = ids.imdbId;
        }
    }
    if (!idType || !fullMediaId) {
        return null;
    }

    const urlPath = `${baseUrl}/${rpdbkey}/${idType}/poster-default/${fullMediaId}.jpg`;
    //console.log(urlPath);
    if (tier === "t0" || tier === "t1" || lang === "en") {
        return `${urlPath}?fallback=true`;
    } else {
        return `${urlPath}?fallback=true&lang=${lang}`;
    }
}

async function checkIfExists(url) {
  try {
    const response = await axios.head(url, {
      maxRedirects: 0,
      validateStatus: () => true,
      headers: { 'User-Agent': 'AIOMetadataAddon/1.0' }
    });
    return response.status === 200;
  } catch (error) {
    if (error.message.includes('Invalid URL')) {
      return false;
    }
    console.error(`Network error in checkIfExists for URL ${url}:`, error.message);
    return false;
  }
}

async function parsePoster(type, ids, fallbackFullUrl, language, rpdbkey) {
  if (rpdbkey) {
    const rpdbImage = getRpdbPoster(type, ids, language, rpdbkey);
    if (rpdbImage && await checkIfExists(rpdbImage)) {
      return rpdbImage;
    }
  }
  return fallbackFullUrl;
}

// Helper to resolve art provider, using meta provider if artProvider is 'meta'
function resolveArtProvider(type, config) {
  const artProvider = config.artProviders?.[type];
  if (artProvider === 'meta' || !artProvider) {
    // Use the selected meta provider for this type
    return config.providers?.[type] || (type === 'anime' ? 'mal' : type === 'movie' ? 'tmdb' : 'tvdb');
  }
  return artProvider;
}

async function getAnimeBg({ tvdbId, tmdbId, malId, malPosterUrl, mediaType = 'series' }, config) {
  
  console.log(`[getAnimeBg] Fetching background for ${mediaType} with TVDB ID: ${tvdbId}, TMDB ID: ${tmdbId}, MAL ID: ${malId}`);
  
  // Check art provider preference
  const artProvider = resolveArtProvider('anime', config);
  
  if (artProvider === 'anilist' && malId) {
    try {
      const anilistData = await anilist.getAnimeArtwork(malId);
      console.log(`[getAnimeBg] AniList data for MAL ID ${malId}:`, {
        hasData: !!anilistData,
        hasBannerImage: !!anilistData?.bannerImage,
        bannerImage: anilistData?.bannerImage?.substring(0, 50) + '...'
      });
      
      if (anilistData) {
        const anilistBackground = anilist.getBackgroundUrl(anilistData);
        console.log(`[getAnimeBg] AniList background URL for MAL ID ${malId}:`, anilistBackground?.substring(0, 50) + '...');
        
        if (anilistBackground) {
          console.log(`[getAnimeBg] Found AniList background for MAL ID: ${malId}`);
          return anilistBackground;
        } else {
          console.log(`[getAnimeBg] No AniList background URL found for MAL ID: ${malId}`);
        }
      }
    } catch (error) {
      console.warn(`[getAnimeBg] AniList background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (artProvider === 'tvdb' && malId) {
    try {
      const mapping = idMapper.getMappingByMalId(malId);
      if (mapping && mapping.thetvdb_id) {
        // Use the appropriate TVDB function based on media type
        const tvdbBackground = mediaType === 'movie'
          ? await tvdb.getMovieBackground(mapping.thetvdb_id, config)
          : await tvdb.getSeriesBackground(mapping.thetvdb_id, config);
        
        if (tvdbBackground) {
          console.log(`[getAnimeBg] Found TVDB background for MAL ID: ${malId} (TVDB ID: ${mapping.thetvdb_id}, Type: ${mediaType})`);
          return tvdbBackground;
        }
      }
    } catch (error) {
      console.warn(`[getAnimeBg] TVDB background fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (config.apiKeys.fanart) {
    let fanartUrl = null;
    if (mediaType === 'series' && tvdbId) {
      fanartUrl = await fanart.getBestSeriesBackground(tvdbId, config);
    } else if (mediaType === 'movie' && tmdbId) {
      fanartUrl = await fanart.getBestMovieBackground(tmdbId, config);
    }

    if (fanartUrl) {
      console.log(`[getAnimeBg] Found high-quality Fanart.tv background.`);
      return fanartUrl;
    }
  }

  console.log(`[getAnimeBg] No Fanart or TMDB background found. Falling back to MAL poster.`);
  return malPosterUrl;
}


/**
 * Get anime logo with art provider preference
 */
async function getAnimeLogo({ malId, mediaType = 'series' }, config) {
  const artProvider = resolveArtProvider('anime', config);
  const mapping = idMapper.getMappingByMalId(malId);
  const tvdbId = mapping?.thetvdb_id;
  const tmdbId = mapping?.themoviedb_id;
  
  if (artProvider === 'tvdb' && malId) {
    try {
      const mapping = idMapper.getMappingByMalId(malId);
      if (mapping && mapping.thetvdb_id) {
        // Use the appropriate TVDB function based on media type
        const tvdbLogo = mediaType === 'movie'
          ? await tvdb.getMovieLogo(mapping.thetvdb_id, config)
          : await tvdb.getSeriesLogo(mapping.thetvdb_id, config);
        
        if (tvdbLogo) {
          console.log(`[getAnimeLogo] Found TVDB logo for MAL ID: ${malId} (TVDB ID: ${mapping.thetvdb_id}, Type: ${mediaType})`);
          return tvdbLogo;
        }
      }
    } catch (error) {
      console.warn(`[getAnimeLogo] TVDB logo fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  // fallback to fanart
  if (config.apiKeys.fanart) {
    let fanartUrl = null;
    if (mediaType === 'series' && tvdbId) {
      fanartUrl = await fanart.getBestTVLogo(tvdbId, config);
    } else if (mediaType === 'movie' && tmdbId) {
      fanartUrl = await fanart.getBestMovieLogo(tmdbId, config);
    }
    if (fanartUrl) {
      console.log(`[getAnimeLogo] Found high-quality back up logo from Fanart.tv.`);
      return fanartUrl;
    }
  }
  return null;
}

/**
 * Get anime poster with art provider preference
 */
async function getAnimePoster({ malId, malPosterUrl, mediaType = 'series' }, config) {
  const artProvider = resolveArtProvider('anime', config);
  const mapping = idMapper.getMappingByMalId(malId);
  const tvdbId = mapping?.thetvdb_id;
  const tmdbId = mapping?.themoviedb_id;
  if (artProvider === 'anilist' && malId) {
    try {
      const anilistData = await anilist.getAnimeArtwork(malId);
      if (anilistData) {
        const anilistPoster = anilist.getPosterUrl(anilistData);
        if (anilistPoster) {
          console.log(`[getAnimePoster] Found AniList poster for MAL ID: ${malId}`);
          return anilistPoster;
        }
      }
    } catch (error) {
      console.warn(`[getAnimePoster] AniList poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  if (artProvider === 'tvdb' && malId) {
    try {
      const mapping = idMapper.getMappingByMalId(malId);
      if (mapping && mapping.thetvdb_id) {
        // Use the appropriate TVDB function based on media type
        const tvdbPoster = mediaType === 'movie' 
          ? await tvdb.getMoviePoster(mapping.thetvdb_id, config)
          : await tvdb.getSeriesPoster(mapping.thetvdb_id, config);
        
        if (tvdbPoster) {
          console.log(`[getAnimePoster] Found TVDB poster for MAL ID: ${malId} (TVDB ID: ${mapping.thetvdb_id}, Type: ${mediaType})`);
          return tvdbPoster;
        }
      }
    } catch (error) {
      console.warn(`[getAnimePoster] TVDB poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  if (config.apiKeys.fanart) {
    let fanartUrl = null;
    console.log(`[getAnimePoster] Fetching background for ${mediaType} with TVDB ID: ${tvdbId}, TMDB ID: ${tmdbId}`);
    if (mediaType === 'series' && tvdbId) {
      fanartUrl = await fanart.getBestSeriesPoster(tvdbId, config);
    } else if (mediaType === 'movie' && tmdbId) {
      fanartUrl = await fanart.getBestMoviePoster(tmdbId, config);
    }

    if (fanartUrl) {
      console.log(`[getAnimePoster] Found high-quality back up poster from Fanart.tv.`);
      return fanartUrl;
    }
  }
  
  return malPosterUrl;
}

/**
 * Get batch anime artwork for catalog usage
 */
async function getBatchAnimeArtwork(malIds, config) {
  const artProvider = resolveArtProvider('anime', config);
  
  if (artProvider === 'anilist' && malIds && malIds.length > 0) {
    try {
      const artworkData = await anilist.getCatalogArtwork(malIds);
      console.log(`[getBatchAnimeArtwork] Retrieved ${artworkData.length} AniList artworks for ${malIds.length} MAL IDs`);
      return artworkData;
    } catch (error) {
      console.warn(`[getBatchAnimeArtwork] AniList batch fetch failed:`, error.message);
    }
  }
  
  return [];
}

async function parseAnimeCatalogMeta(anime, config, language, descriptionFallback = null) {
  if (!anime || !anime.mal_id) return null;

  const malId = anime.mal_id;
  const stremioType = anime.type?.toLowerCase() === 'movie' ? 'movie' : 'series';
  const preferredProvider = config.providers?.anime || 'mal';

  const mapping = idMapper.getMappingByMalId(malId);
  let id = `mal:${malId}`;
  const kitsuId = mapping?.kitsu_id;
  if (preferredProvider === 'tvdb') {
    if (mapping && mapping.thetvdb_id) {
      id= `tvdb:${mapping.thetvdb_id}`;
    }
  } else if (preferredProvider === 'tmdb') {
    if (mapping && mapping.themoviedb_id) {
      id = `tmdb:${mapping.themoviedb_id}`;
    }
  } else if (preferredProvider === 'imdb') {
    if (mapping && mapping.imdb_id) {
      id= `${mapping.imdb_id}`;
    }
  } 
  
  const malPosterUrl = anime.images?.jpg?.large_image_url;
  let finalPosterUrl = malPosterUrl || `https://artworks.thetvdb.com/banners/images/missing/series.jpg`;
  
  // Check art provider preference
  const artProvider = resolveArtProvider('anime', config);
  if (artProvider === 'anilist' && malId) {
    try {
      const anilistData = await anilist.getAnimeArtwork(malId);
      if (anilistData) {
        const anilistPoster = anilist.getPosterUrl(anilistData);
        if (anilistPoster) {
          console.log(`[parseAnimeCatalogMeta] Using AniList poster for MAL ID: ${malId}`);
          finalPosterUrl = anilistPoster;
        }
      }
    } catch (error) {
      console.warn(`[parseAnimeCatalogMeta] AniList poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  } else if (artProvider === 'tvdb' && malId) {
    try {
      const mapping = idMapper.getMappingByMalId(malId);
      if (mapping && mapping.thetvdb_id) {
        // Use the appropriate TVDB function based on media type
        const tvdbPoster = stremioType === 'movie'
          ? await tvdb.getMoviePoster(mapping.thetvdb_id, config)
          : await tvdb.getSeriesPoster(mapping.thetvdb_id, config);
        
        if (tvdbPoster) {
          console.log(`[parseAnimeCatalogMeta] Using TVDB poster for MAL ID: ${malId} (TVDB ID: ${mapping.thetvdb_id}, Type: ${stremioType})`);
          finalPosterUrl = tvdbPoster;
        }
      }
    } catch (error) {
      console.warn(`[parseAnimeCatalogMeta] TVDB poster fetch failed for MAL ID ${malId}:`, error.message);
    }
  }
  
  //const kitsuId = mapping?.kitsu_id;
  //const imdbId = mapping?.imdb_id;
  //const metaType = (kitsuId || imdbId) ? stremioType : 'anime';
  if (config.apiKeys?.rpdb) {

    if (mapping) {
      const tvdbId = mapping.thetvdb_id;
      const tmdbId = mapping.themoviedb_id;
      let proxyId = null;

      if (stremioType === 'series') {
        proxyId = tvdbId ? `tvdb:${tvdbId}` : (tmdbId ? `tmdb:${tmdbId}` : null);
      } else if (stremioType === 'movie') {
        proxyId = tmdbId ? `tmdb:${tmdbId}` : null;
      }

      if (proxyId) {
        const fallback = encodeURIComponent(finalPosterUrl);
        finalPosterUrl = `${host}/poster/${stremioType}/${proxyId}?fallback=${fallback}&lang=${language}&key=${config.apiKeys?.rpdb}`;
      }
    }
  }
  const trailerStreams = [];
  if (anime.trailer?.youtube_id) {
    trailerStreams.push({
      ytId: anime.trailer.youtube_id,
      title: anime.title_english || anime.title
    });
  }
  const trailers = [];
  if (anime.trailer?.youtube_id) {
    trailers.push({
      source: anime.trailer.youtube_id,
      type: "Trailer",
      name: anime.title_english || anime.title
    });
  }
  return {
    id: `mal:${malId}`,
    type: stremioType,
    name: anime.title_english || anime.title,
    poster: finalPosterUrl,
    description: descriptionFallback || anime.synopsis,
    year: anime.year,
    imdb_id: mapping?.imdb_id,
    releaseInfo: anime.year,
    runtime: parseRunTime(anime.runtime),
    isAnime: true,
    trailers: trailers,
    trailerStreams: trailerStreams
  };
}

/**
 * Batch version of parseAnimeCatalogMeta that uses AniList batch fetching for better performance
 */
async function parseAnimeCatalogMetaBatch(animes, config, language) {
  if (!animes || animes.length === 0) return [];

  const artProvider = resolveArtProvider('anime', config);
  const useAniList = artProvider === 'anilist';
  const useTvdb = artProvider === 'tvdb';
  console.log(`[parseAnimeCatalogMetaBatch] Art provider: ${artProvider}, useAniList: ${useAniList}, useTvdb: ${useTvdb}`);
  
  // Extract MAL IDs and try to get AniList IDs from mappings
  const malIds = animes.map(anime => anime.mal_id).filter(id => id && typeof id === 'number' && id > 0);
  let anilistArtworkMap = new Map();
  
  if (useAniList && malIds.length > 0) {
    try {
      console.log(`[parseAnimeCatalogMetaBatch] Fetching AniList artwork for ${malIds.length} anime in batch`);
      console.log(`[parseAnimeCatalogMetaBatch] MAL IDs: ${malIds.slice(0, 10).join(', ')}${malIds.length > 10 ? '...' : ''}`);
      
      // First, try to get AniList IDs from mappings
      const malToAnilistMap = new Map();
      const anilistIds = [];
      const malIdsWithoutAnilist = [];
      
      malIds.forEach(malId => {
        const mapping = idMapper.getMappingByMalId(malId);
        if (mapping && mapping.anilist_id) {
          malToAnilistMap.set(mapping.anilist_id, malId);
          anilistIds.push(mapping.anilist_id);
        } else {
          malIdsWithoutAnilist.push(malId);
        }
      });
      
      console.log(`[parseAnimeCatalogMetaBatch] Found ${anilistIds.length} AniList IDs, ${malIdsWithoutAnilist.length} MAL IDs without AniList mapping`);
      
      let anilistArtwork = [];
      
      // Batch fetch using AniList IDs if we have them
      if (anilistIds.length > 0) {
        console.log(`[parseAnimeCatalogMetaBatch] Fetching via AniList IDs: ${anilistIds.slice(0, 10).join(', ')}${anilistIds.length > 10 ? '...' : ''}`);
        const anilistResults = await anilist.getBatchAnimeArtworkByAnilistIds(anilistIds);
        anilistArtwork.push(...anilistResults);
      }
      
      // Fallback to MAL IDs for those without AniList mappings
      if (malIdsWithoutAnilist.length > 0) {
        console.log(`[parseAnimeCatalogMetaBatch] Fallback to MAL IDs: ${malIdsWithoutAnilist.slice(0, 10).join(', ')}${malIdsWithoutAnilist.length > 10 ? '...' : ''}`);
        const malResults = await anilist.getBatchAnimeArtwork(malIdsWithoutAnilist, config);
        anilistArtwork.push(...malResults);
      }
      
      // Create a map for quick lookup - use idMal since that's what both methods return
      anilistArtworkMap = new Map(
        anilistArtwork.map(artwork => [artwork.idMal, artwork])
      );
      console.log(`[parseAnimeCatalogMetaBatch] Successfully fetched ${anilistArtwork.length} AniList artworks`);
      console.log(`[parseAnimeCatalogMetaBatch] AniList map keys: ${Array.from(anilistArtworkMap.keys()).slice(0, 5).join(', ')}...`);
      console.log(`[parseAnimeCatalogMetaBatch] Sample AniList data:`, anilistArtwork[0] ? {
        malId: anilistArtwork[0].idMal,
        id: anilistArtwork[0].id,
        title: anilistArtwork[0].title?.english || anilistArtwork[0].title?.romaji
      } : 'No data');
    } catch (error) {
      console.warn(`[parseAnimeCatalogMetaBatch] AniList batch fetch failed:`, error.message);
    }
  }

  // Process each anime
  const results = await Promise.all(animes.map(async anime => {
    if (!anime || !anime.mal_id) return null;

    const malId = anime.mal_id;
    const stremioType = anime.type?.toLowerCase() === 'movie' ? 'movie' : 'series';
    const preferredProvider = config.providers?.anime || 'mal';

    const mapping = idMapper.getMappingByMalId(malId);
    let id = `mal:${malId}`;
    const kitsuId = mapping?.kitsu_id;
    if (preferredProvider === 'tvdb') {
      if (mapping && mapping.thetvdb_id) {
        id= `tvdb:${mapping.thetvdb_id}`;
      }
    } else if (preferredProvider === 'tmdb') {
      if (mapping && mapping.themoviedb_id) {
        id = `tmdb:${mapping.themoviedb_id}`;
      }
    } else if (preferredProvider === 'imdb') {
      if (mapping && mapping.imdb_id) {
        id= `${mapping.imdb_id}`;
      }
    } 
    
    const malPosterUrl = anime.images?.jpg?.large_image_url;
    let finalPosterUrl = malPosterUrl || `https://artworks.thetvdb.com/banners/images/missing/series.jpg`;
    
    // Use batch-fetched AniList artwork if available
    if (useAniList && anilistArtworkMap.has(malId)) {
      const anilistData = anilistArtworkMap.get(malId);
      const anilistPoster = anilist.getPosterUrl(anilistData);
      if (anilistPoster) {
        console.log(`[parseAnimeCatalogMetaBatch] Using AniList poster for MAL ID: ${malId}`);
        finalPosterUrl = anilistPoster;
      } else {
        console.log(`[parseAnimeCatalogMetaBatch] AniList data found but no poster URL for MAL ID: ${malId}`);
      }
    } else if (useAniList) {
      console.log(`[parseAnimeCatalogMetaBatch] No AniList data found for MAL ID: ${malId}`);
    }
    
    // Check for TVDB poster if configured as art provider
    if (useTvdb && mapping && mapping.thetvdb_id) {
      try {
        // Use the appropriate TVDB function based on media type
        const tvdbPoster = stremioType === 'movie'
          ? await tvdb.getMoviePoster(mapping.thetvdb_id, config)
          : await tvdb.getSeriesPoster(mapping.thetvdb_id, config);
        
        if (tvdbPoster) {
          console.log(`[parseAnimeCatalogMetaBatch] Using TVDB poster for MAL ID: ${malId} (TVDB ID: ${mapping.thetvdb_id}, Type: ${stremioType})`);
          finalPosterUrl = tvdbPoster;
        }
      } catch (error) {
        console.warn(`[parseAnimeCatalogMetaBatch] TVDB poster fetch failed for MAL ID ${malId}:`, error.message);
      }
    }
    
    if (config.apiKeys?.rpdb) {
      if (mapping) {
        const tvdbId = mapping.thetvdb_id;
        const tmdbId = mapping.themoviedb_id;
        let proxyId = null;

        if (stremioType === 'series') {
          proxyId = tvdbId ? `tvdb:${tvdbId}` : (tmdbId ? `tmdb:${tmdbId}` : null);
        } else if (stremioType === 'movie') {
          proxyId = tmdbId ? `tmdb:${tmdbId}` : null;
        }

        if (proxyId) {
          const fallback = encodeURIComponent(finalPosterUrl);
          finalPosterUrl = `${host}/poster/${stremioType}/${proxyId}?fallback=${fallback}&lang=${language}&key=${config.apiKeys?.rpdb}`;
        }
      }
    }

    const trailerStreams = [];
    if (anime.trailer?.youtube_id) {
      trailerStreams.push({
        ytId: anime.trailer.youtube_id,
        title: anime.title_english || anime.title
      });
    }
    const trailers = [];
    if (anime.trailer?.youtube_id) {
      trailers.push({
        source: anime.trailer.youtube_id,
        type: "Trailer",
        name: anime.title_english || anime.title
      });
    }

    return {
      id: `mal:${malId}`,
      type: stremioType,
      name: anime.title_english || anime.title,
      poster: finalPosterUrl,
      description: anime.synopsis,
      year: anime.year,
      imdb_id: mapping?.imdb_id,
      releaseInfo: anime.year,
      runtime: anime.runtime,
      trailers: trailers,
      trailerStreams: trailerStreams
      };
  }));
  
  return results.filter(Boolean);
}

/**
 * Parses a YouTube URL and extracts the video ID (the 'v' parameter).
 * @param {string} url - The full YouTube URL.
 * @returns {string|null} The YouTube video ID, or null if not found.
 */
function getYouTubeIdFromUrl(url) {
  if (!url) return null;
  try {
    const urlObject = new URL(url);
    // Standard YouTube URLs have the ID in the 'v' query parameter.
    if (urlObject.hostname === 'www.youtube.com' || urlObject.hostname === 'youtube.com') {
      return urlObject.searchParams.get('v');
    }
    // Handle youtu.be short links
    if (urlObject.hostname === 'youtu.be') {
      return urlObject.pathname.slice(1); // Remove the leading '/'
    }
  } catch (error) {
    console.warn(`[Parser] Could not parse invalid URL for YouTube ID: ${url}`);
  }
  return null;
}

/**
 * Parses the trailers array from the TVDB API into Stremio-compatible formats.
 * @param {Array} tvdbTrailers - The `trailers` array from the TVDB API response.
 * @param {string} defaultTitle - A fallback title to use for the trailer.
 * @returns {{trailers: Array, trailerStreams: Array}} An object containing both formats.
 */
function parseTvdbTrailers(tvdbTrailers, defaultTitle = 'Official Trailer') {
  const trailers = [];
  const trailerStreams = [];

  if (!Array.isArray(tvdbTrailers)) {
    return { trailers, trailerStreams };
  }

  for (const trailer of tvdbTrailers) {
    if (trailer.url && trailer.url.includes('youtube.com') || trailer.url.includes('youtu.be')) {
      const ytId = getYouTubeIdFromUrl(trailer.url);

      if (ytId) {
        const title = trailer.name || defaultTitle;

        trailers.push({
          source: ytId,
          type: 'Trailer',
          name: defaultTitle
        });

        trailerStreams.push({
          ytId: ytId,
          title: title
        });
      }
    }
  }

  return { trailers, trailerStreams };
}

/**
 * Get movie poster with art provider preference
 */
async function getMoviePoster({ tmdbId, tvdbId, metaProvider, fallbackPosterUrl }, config) {
  const artProvider = resolveArtProvider('movie', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
      const tvdbPoster = await tvdb.getMoviePoster(tvdbId, config);
      if (tvdbPoster) {
        console.log(`[getMoviePoster] Found TVDB poster for movie (TVDB ID: ${tvdbId})`);
          return tvdbPoster;
        }
      }
      else {
        if(!tmdbId) return fallbackPosterUrl;
        const mappedIds = await idMapper.resolveIds({ tmdbId });
        if(mappedIds.tvdbId) {
          const tvdbPoster = await tvdb.getMoviePoster(mappedIds.tvdbId, config);
          console.log(`[getMoviePoster] Found TVDB poster via ID mapping for movie (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbPoster;
        }
      }
    } catch (error) {
      console.warn(`[getMoviePoster] TVDB poster fetch failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const fanartPoster = await fanart.getBestMoviePoster(tmdbId, config);
        if (fanartPoster) {
          console.log(`[getMoviePoster] Found Fanart.tv poster for movie (TMDB ID: ${tmdbId})`);
          return fanartPoster;
        }
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await idMapper.resolveIds({ tvdbId });
        if(mappedIds.tmdbId) {
          const fanartPoster = await fanart.getBestMoviePoster(mappedIds.tmdbId, config);
          console.log(`[getMoviePoster] Found Fanart.tv poster via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
          return fanartPoster;
        }
      }
    } catch (error) {
      console.warn(`[getMoviePoster] Fanart.tv poster fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const tmdbPoster = await tmdb.movieImages({ id: tmdbId }, config).then(res => res.posters.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.posters[0].file_path);
        console.log(`[getMoviePoster] Found TMDB poster for movie (TMDB ID: ${tmdbId})`);
        return `https://image.tmdb.org/t/p/w500${tmdbPoster}`;
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await idMapper.resolveIds({ tvdbId });
        if(mappedIds.tmdbId) {
          const tmdbPoster = await tmdb.movieImages({ id: mappedIds.tmdbId }, config).then(res => res.posters.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.posters[0].file_path);
          console.log(`[getMoviePoster] Found TMDB poster via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
          return `https://image.tmdb.org/t/p/w500${tmdbPoster}`;
        }
      }
    } catch (error) {
      console.warn(`[getMoviePoster] TMDB ID mapping failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }

  return fallbackPosterUrl;
}

/**
 * Get movie background with art provider preference
 */
async function getMovieBackground({ tmdbId, tvdbId, metaProvider, fallbackBackgroundUrl }, config) {
  const artProvider = resolveArtProvider('movie', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        console.log(`[getMovieBackground] Fetching TVDB background for movie (TVDB ID: ${tvdbId})`);
        const tvdbBackground = await tvdb.getMovieBackground(tvdbId, config);
        if (tvdbBackground) {
          console.log(`[getMovieBackground] Found TVDB background for movie (TVDB ID: ${tvdbId}): ${tvdbBackground.substring(0, 50)}...`);
          return tvdbBackground;
        }
      }
      else {
        if(!tmdbId) return fallbackBackgroundUrl;
        const mappedIds = await idMapper.resolveIds({ tmdbId });
        if(mappedIds.tvdbId) {
          const tvdbBackground = await tvdb.getMovieBackground(mappedIds.tvdbId, config);
          console.log(`[getMovieBackground] Found TVDB background via ID mapping for movie (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbBackground;
        }
      }
    } catch (error) {
      console.warn(`[getMovieBackground] TVDB background fetch failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const fanartBackground = await fanart.getBestMovieBackground(tmdbId, config);
        if (fanartBackground) {
          console.log(`[getMovieBackground] Found Fanart.tv background for movie (TMDB ID: ${tmdbId})`);
          return fanartBackground;
        }
      }
      else {
        if(!tvdbId) return fallbackBackgroundUrl;
        const mappedIds = await idMapper.resolveIds({ tvdbId });
        if(mappedIds.tmdbId) {
          const fanartBackground = await fanart.getBestMovieBackground(mappedIds.tmdbId, config);
          console.log(`[getMovieBackground] Found Fanart.tv background via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
          return fanartBackground;
        }
      }
    } catch (error) {
      console.warn(`[getMovieBackground] Fanart.tv background fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const tmdbBackground = await tmdb.movieImages({ id: tmdbId }, config).then(res => res.backdrops.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.backdrops[0].file_path);
        console.log(`[getMovieBackground] Found TMDB background for movie (TMDB ID: ${tmdbId})`);
        return `https://image.tmdb.org/t/p/original${tmdbBackground}`;
      }
      else {
        if(!tvdbId) return fallbackBackgroundUrl;
        const mappedIds = await idMapper.resolveIds({ tvdbId });
        if(mappedIds.tmdbId) {
          const tmdbBackground = await tmdb.movieImages({ id: mappedIds.tmdbId }, config).then(res => res.backdrops.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.backdrops[0].file_path);
          console.log(`[getMovieBackground] Found TMDB background via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
          return `https://image.tmdb.org/t/p/original${tmdbBackground}`;
        }
      }
    } catch (error) {
      console.warn(`[getMovieBackground] TMDB ID mapping failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  
  return fallbackBackgroundUrl;
}

/**
 * Get movie logo with art provider preference
 */
async function getMovieLogo({ tmdbId, tvdbId, metaProvider, fallbackLogoUrl }, config) {
  const artProvider = resolveArtProvider('movie', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        const tvdbLogo = await tvdb.getMovieLogo(tvdbId, config);
        if (tvdbLogo) {
          console.log(`[getMovieLogo] Found TVDB logo for movie (TVDB ID: ${tvdbId})`);
          return tvdbLogo;
        }
      }
      else {
        if(!tmdbId) return fallbackLogoUrl;
        const mappedIds = await idMapper.resolveIds({ tmdbId });
        if(mappedIds.tvdbId) {
          const tvdbLogo = await tvdb.getMovieLogo(mappedIds.tvdbId, config);
          console.log(`[getMovieLogo] Found TVDB logo via ID mapping for movie (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbLogo;
        }
      }
    } catch (error) {
      console.warn(`[getMovieLogo] TVDB logo fetch failed for movie (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const fanartImages = await fanart.getMovieImages(tmdbId, config);
        if (fanartImages && fanartImages.hdmovielogo && fanartImages.hdmovielogo.length > 0) {
        const language = config.language?.split('-')[0] || 'en';
        const requestedLangLogo = fanartImages.hdmovielogo.find(logo => logo.lang === language);
        const englishLogo = fanartImages.hdmovielogo.find(logo => logo.lang === 'en');
          const selectedLogo = requestedLangLogo || englishLogo || fanartImages.hdmovielogo[0];
          if (selectedLogo) {
            console.log(`[getMovieLogo] Found Fanart.tv logo for movie (TMDB ID: ${tmdbId}, lang: ${selectedLogo.lang})`);
            return selectedLogo.url;
          }
        }
        else {
          if(!tvdbId) return fallbackLogoUrl;
          const mappedIds = await idMapper.resolveIds({ tvdbId });
          if(mappedIds.tmdbId) {
            const fanartImages = await fanart.getMovieImages(mappedIds.tmdbId, config);
            const selectedLogo = requestedLangLogo || englishLogo || fanartImages.hdmovielogo[0];
            if (selectedLogo) {
              console.log(`[getMovieLogo] Found Fanart.tv logo via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId}, lang: ${selectedLogo.lang})`);
              return selectedLogo.url;
            }
          }
        }
        if (selectedLogo) {
          console.log(`[getMovieLogo] Found Fanart.tv logo for movie (TMDB ID: ${tmdbId}, lang: ${selectedLogo.lang})`);
          return selectedLogo.url;
        }
      }
    } catch (error) {
      console.warn(`[getMovieLogo] Fanart.tv logo fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const tmdbLogo = await tmdb.movieImages({ id: tmdbId }, config).then(res => res.logos.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.logos[0].file_path);
        if (tmdbLogo) {
          console.log(`[getMovieLogo] Found TMDB logo for movie (TMDB ID: ${tmdbId})`);
          return `https://image.tmdb.org/t/p/w500${tmdbLogo}`;
        }
      }
      else {
        if(!tvdbId) return fallbackLogoUrl;
        const mappedIds = await idMapper.resolveIds({ tvdbId });
        if(mappedIds.tmdbId) {
          const tmdbLogo = await tmdb.movieImages({ id: mappedIds.tmdbId }, config).then(res => res.logos.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.logos[0].file_path);
          if (tmdbLogo) {
            console.log(`[getMovieLogo] Found TMDB logo via ID mapping for movie (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return `https://image.tmdb.org/t/p/w500${tmdbLogo}`;
          }
        }
      }
    } catch (error) {
      console.warn(`[getMovieLogo] TMDB logo fetch failed for movie (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  return fallbackLogoUrl;
}

/**
 * Get series poster with art provider preference
 */
async function getSeriesPoster({ tmdbId, tvdbId, metaProvider, fallbackPosterUrl }, config) {
  const artProvider = resolveArtProvider('series', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        const tvdbPoster = await tvdb.getSeriesPoster(tvdbId, config);
        if (tvdbPoster) {
        console.log(`[getSeriesPoster] Found TVDB poster for series (TVDB ID: ${tvdbId})`);
        return tvdbPoster;
      }
      else {
        if(!tmdbId) return fallbackPosterUrl;
        const mappedIds = await idMapper.resolveIds({ tmdbId });
        if(mappedIds.tvdbId) {
          const tvdbPoster = await tvdb.getSeriesPoster(mappedIds.tvdbId, config);
          console.log(`[getSeriesPoster] Found TVDB poster via ID mapping for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbPoster;
        }
      }
    }
    } catch (error) {
      console.warn(`[getSeriesPoster] TVDB poster fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const fanartPoster = await fanart.getBestSeriesPoster(tmdbId, config);
        if (fanartPoster) {
        console.log(`[getSeriesPoster] Found Fanart.tv poster for series (TVDB ID: ${tvdbId})`);
        return fanartPoster;
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await idMapper.resolveIds({ tvdbId });
        if(mappedIds.tmdbId) {
          const fanartPoster = await fanart.getBestSeriesPoster(mappedIds.tmdbId, config);
          console.log(`[getSeriesPoster] Found Fanart.tv poster via ID mapping for series (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
          return fanartPoster;
        }
      }
    }
    } catch (error) {
      console.warn(`[getSeriesPoster] Fanart.tv poster fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const tmdbPoster = await tmdb.tvImages({ id: tmdbId }, config).then(res => res.posters.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.posters[0].file_path);
        if (tmdbPoster) {
          console.log(`[getSeriesPoster] Found TMDB poster for series (TMDB ID: ${tmdbId})`);
          return `https://image.tmdb.org/t/p/w500${tmdbPoster}`;
        }
      }
      else {
        if(!tvdbId) return fallbackPosterUrl;
        const mappedIds = await idMapper.resolveIds({ tvdbId });
        if(mappedIds.tmdbId) {
          const tmdbPoster = await tmdb.tvImages({ id: mappedIds.tmdbId }, config).then(res => res.posters.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.posters[0].file_path);
          if (tmdbPoster) {
            console.log(`[getSeriesPoster] Found TMDB poster via ID mapping for series (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return `https://image.tmdb.org/t/p/w500${tmdbPoster}`;
          }
        }
      }
    } catch (error) {
      console.warn(`[getSeriesPoster] TMDB ID mapping failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  return fallbackPosterUrl;
}

/**
 * Get series background with art provider preference
 */
async function getSeriesBackground({ tmdbId, tvdbId, metaProvider, fallbackBackgroundUrl }, config) {
  const artProvider = resolveArtProvider('series', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
      const tvdbBackground = await tvdb.getSeriesBackground(tvdbId, config);
      if (tvdbBackground) {
        console.log(`[getSeriesBackground] Found TVDB background for series (TVDB ID: ${tvdbId})`);
          return tvdbBackground;
        }
      }
      else {
        if(!tmdbId) return fallbackBackgroundUrl;
        const mappedIds = await idMapper.resolveIds({ tmdbId });
        if(mappedIds.tvdbId) {
          const tvdbBackground = await tvdb.getSeriesBackground(mappedIds.tvdbId, config);
          console.log(`[getSeriesBackground] Found TVDB background via ID mapping for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbBackground;
        }
      }
    } catch (error) {
      console.warn(`[getSeriesBackground] TVDB background fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart' && tvdbId) {
    try {
      const fanartBackground = await fanart.getBestSeriesBackground(tvdbId, config);
      if (fanartBackground) {
        console.log(`[getSeriesBackground] Found Fanart.tv background for series (TVDB ID: ${tvdbId})`);
        return fanartBackground;
      }
    } catch (error) {
      console.warn(`[getSeriesBackground] Fanart.tv background fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      // Try to get TMDB ID from TVDB ID via ID mapping
      if(tmdbId) {
        const tmdbBackground = await tmdb.tvImages({ id: tmdbId }, config).then(res => res.backdrops.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.backdrops[0].file_path);
        console.log(`[getSeriesBackground] Found TMDB background for series (TMDB ID: ${tmdbId})`);
        return `https://image.tmdb.org/t/p/original${tmdbBackground}`;
      }
      else {
        const mappedIds = await idMapper.resolveIds({ tvdbId });
        if(mappedIds.tmdbId) {
          const tmdbBackground = await tmdb.tvImages({ id: mappedIds.tmdbId }, config).then(res => res.backdrops.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.backdrops[0].file_path);
          console.log(`[getSeriesBackground] Found TMDB background via ID mapping for series (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
          return `https://image.tmdb.org/t/p/original${tmdbBackground}`;
        }
      }
    } catch (error) {
      console.warn(`[getSeriesBackground] TMDB ID mapping failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  // Fallback to meta background
  return fallbackBackgroundUrl;
}

/**
 * Get series logo with art provider preference
 */
async function getSeriesLogo({ tmdbId, tvdbId, metaProvider, fallbackLogoUrl }, config) {
  const artProvider = resolveArtProvider('series', config);
  
  if (artProvider === 'tvdb' && metaProvider != 'tvdb') {
    try {
      if(tvdbId) {
        const tvdbLogo = await tvdb.getSeriesLogo(tvdbId, config);
        if (tvdbLogo) {
        console.log(`[getSeriesLogo] Found TVDB logo for series (TVDB ID: ${tvdbId})`);
          return tvdbLogo;
        }
      }
      else {
        if(!tmdbId) return fallbackLogoUrl;
        const mappedIds = await idMapper.resolveIds({ tmdbId });
        if(mappedIds.tvdbId) {
          const tvdbLogo = await tvdb.getSeriesLogo(mappedIds.tvdbId, config);
          console.log(`[getSeriesLogo] Found TVDB logo via ID mapping for series (TMDB ID: ${tmdbId} → TVDB ID: ${mappedIds.tvdbId})`);
          return tvdbLogo;
        }
      }
    } catch (error) {
      console.warn(`[getSeriesLogo] TVDB logo fetch failed for series (TVDB ID: ${tvdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'fanart') {
    try {
      if(tmdbId) {
        const fanartImages = await fanart.getShowImages(tmdbId, config);
        if (fanartImages && fanartImages.hdtvlogo && fanartImages.hdtvlogo.length > 0) {
          const language = config.language?.split('-')[0] || 'en';
          const requestedLangLogo = fanartImages.hdtvlogo.find(logo => logo.lang === language);
          const englishLogo = fanartImages.hdtvlogo.find(logo => logo.lang === 'en');
          
          const selectedLogo = requestedLangLogo || englishLogo || fanartImages.hdtvlogo[0];
          
          if (selectedLogo) {
            console.log(`[getSeriesLogo] Found Fanart.tv logo for series (TVDB ID: ${tvdbId}, lang: ${selectedLogo.lang})`);
            return selectedLogo.url;
          }
        }
      }
      else {
        if(!tvdbId) return fallbackLogoUrl;
        const mappedIds = await idMapper.resolveIds({ tvdbId });
        if(mappedIds.tmdbId) {
          const fanartImages = await fanart.getShowImages(mappedIds.tmdbId, config);
          const selectedLogo = requestedLangLogo || englishLogo || fanartImages.hdtvlogo[0];
          if (selectedLogo) {
            console.log(`[getSeriesLogo] Found Fanart.tv logo via ID mapping for series (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId}, lang: ${selectedLogo.lang})`);
            return selectedLogo.url;
          }
        }
      }
    } catch (error) {
      console.warn(`[getSeriesLogo] Fanart.tv logo fetch failed for series (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  if (artProvider === 'tmdb' && metaProvider != 'tmdb') {
    try {
      if(tmdbId) {
        const tmdbLogo = await tmdb.tvImages({ id: tmdbId }, config).then(res => res.logos.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.logos[0].file_path);
        if (tmdbLogo) {
          console.log(`[getSeriesLogo] Found TMDB logo for series (TMDB ID: ${tmdbId})`);
          return `https://image.tmdb.org/t/p/w500${tmdbLogo}`;
        }
      }
      else {
        if(!tvdbId) return fallbackLogoUrl;
        const mappedIds = await idMapper.resolveIds({ tvdbId });
        if(mappedIds.tmdbId) {
          const tmdbLogo = await tmdb.tvImages({ id: mappedIds.tmdbId }, config).then(res => res.logos.sort((a, b) => b.vote_average - a.vote_average).find(b => b.iso_639_1 === config.language?.split('-')[0] || 'en')?.file_path || res.logos[0].file_path);
          if (tmdbLogo) {
            console.log(`[getSeriesLogo] Found TMDB logo via ID mapping for series (TVDB ID: ${tvdbId} → TMDB ID: ${mappedIds.tmdbId})`);
            return `https://image.tmdb.org/t/p/w500${tmdbLogo}`;
          }
        }
      }
    } catch (error) {
      console.warn(`[getSeriesLogo] TMDB logo fetch failed for series (TMDB ID: ${tmdbId}):`, error.message);
    }
  }
  
  return fallbackLogoUrl;

}


module.exports = {
  parseMedia,
  parseCast,
  parseDirector,
  parseWriter,
  parseSlug,
  parseTrailers,
  parseTrailerStream,
  parseImdbLink,
  parseShareLink,
  parseGenreLink,
  parseCreditsLink,
  buildLinks,
  parseCoutry,
  parseGenres,
  parseYear,
  parseRunTime,
  parseCreatedBy,
  parseConfig,
  parsePoster,
  getRpdbPoster,
  checkIfExists,
  sortSearchResults,
  parseAnimeCreditsLink,
  getAnimeBg,
  parseAnimeCatalogMeta,
  parseAnimeCatalogMetaBatch,
  parseTvdbTrailers,
  parseAnimeRelationsLink,
  parseAnimeGenreLink,
  getAnimePoster,
  getAnimeLogo,
  getBatchAnimeArtwork,
  getMoviePoster,
  getMovieBackground,
  getMovieLogo,
  getSeriesPoster,
  getSeriesBackground,
  getSeriesLogo
};
