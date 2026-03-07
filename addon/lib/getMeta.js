require("dotenv").config();
const Utils = require("../utils/parseProps");
const moviedb = require("./getTmdb");
const tvdb = require("./tvdb");
const imdb = require("./imdb");
const tvmaze = require("./tvmaze");
const { getLogo } = require("./getLogo");
const { getImdbRating } = require("./getImdbRating");
const { to3LetterCode } = require('./language-map');
const jikan = require('./mal');
const TVDB_IMAGE_BASE = 'https://artworks.thetvdb.com';
const idMapper = require('./id-mapper');
const { resolveAnidbEpisodeFromTvdbEpisode } = require('./anime-list-mapper');
const fanart = require('../utils/fanart');
const { isAnime: isAnimeFunc } = require('../utils/isAnime');
const e = require("express");
const { resolveAllIds } = require('./id-resolver');
const { cacheWrapMeta, cacheWrapJikanApi, cacheWrapGlobal } = require('./getCache');
const CATALOG_TTL = parseInt(process.env.CATALOG_TTL || 1 * 24 * 60 * 60, 10);
const kitsu = require('./kitsu');
var nameToImdb = require("name-to-imdb");
const consola = require('consola');
const { cp } = require("fs");
const wikiMappings = require('./wiki-mapper.js');


const logger = consola.withTag('Meta');


const processLogo = (logoUrl) => {
  if (!logoUrl) return null;
  return logoUrl.replace(/^http:/, "https:");
};

/**
 * Creates a Date object from a date string (YYYY-MM-DD or ISO format) at noon in the user's timezone
 * @param {string} dateString - Date string in YYYY-MM-DD format or ISO format (e.g., 1999-10-20T00:00:00+00:00)
 * @param {string} timezone - IANA timezone string (e.g., 'America/New_York', 'UTC')
 * @returns {Date} - Date object representing noon in the specified timezone
 */
const createDateInTimezone = (dateString, timezone = 'UTC') => {
  if (!dateString) return null;
  
  try {
    const dateOnly = dateString.split('T')[0].split(' ')[0];
    // Parse the date string (YYYY-MM-DD)
    const [year, month, day] = dateOnly.split('-').map(Number);
    
    // Create a date at noon UTC as a starting point
    const noonUTC = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    
    // Get what time it is in the target timezone when it's noon UTC
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    
    const localTimeAtNoonUTC = formatter.format(noonUTC);
    const [localHour, localMinute] = localTimeAtNoonUTC.split(':').map(Number);
    
    // Calculate how many hours we need to adjust from noon UTC to get noon in target timezone
    // If it's 7:00 in target timezone when it's noon UTC, we need to go back 5 hours
    const hoursDiff = 12 - localHour;
    const minutesDiff = 0 - localMinute;
    const totalMsDiff = (hoursDiff * 60 + minutesDiff) * 60 * 1000;
    
    // Adjust the UTC time to get noon in the target timezone
    return new Date(noonUTC.getTime() + totalMsDiff);
  } catch (error) {
    logger.warn(`Error creating date in timezone ${timezone} for ${dateString}: ${error.message}`);
    // Fallback to UTC if timezone parsing fails
    return new Date(dateString + 'T12:00:00.000Z');
  }
};

const findArtwork = (artworks, type, lang, config, typeToFind="image") => {
  if (lang === null) {
    return artworks?.find(a => a.type === type && a.language === null)?.[typeToFind]
      || artworks?.find(a => a.type === type)?.[typeToFind];
  }
  
  // If englishArtOnly is enabled, prefer English artwork first
  if (config?.artProviders?.englishArtOnly) {
    return artworks?.find(a => a.type === type && a.language === 'eng')?.[typeToFind]
      || artworks?.find(a => a.type === type)?.[typeToFind];
  }
  // Otherwise use preferred language fallback
  return artworks?.find(a => a.type === type && a.language === lang)?.[typeToFind]
    || artworks?.find(a => a.type === type && a.language === 'eng')?.[typeToFind]
    || artworks?.find(a => a.type === type)?.[typeToFind];
};

async function getAnimeArtwork(allIds, config, fallbackPosterUrl, fallbackBackgroundUrl, type) {
  const [background, poster, logo, imdbRatingValue, landscapePosterUrl] = await Promise.all([
    Utils.getAnimeBg({
      tvdbId: allIds?.tvdbId,
      tmdbId: allIds?.tmdbId,
      malId: allIds?.malId,
      imdbId: allIds?.imdbId,
      malPosterUrl: fallbackBackgroundUrl,
      mediaType: type
    }, config),
    Utils.getAnimePoster({
      malId: allIds?.malId,
      imdbId: allIds?.imdbId,
      tvdbId: allIds?.tvdbId,
      tmdbId: allIds?.tmdbId,
      malPosterUrl: fallbackPosterUrl,
      mediaType: type
    }, config),
    Utils.getAnimeLogo({
      malId: allIds?.malId,
      imdbId: allIds?.imdbId,
      tvdbId: allIds?.tvdbId,
      tmdbId: allIds?.tmdbId,
      mediaType: type
    }, config),
    getImdbRating(allIds?.imdbId, type),
    Utils.getAnimeBg({
      tvdbId: allIds?.tvdbId,
      tmdbId: allIds?.tmdbId,
      malId: allIds?.malId,
      imdbId: allIds?.imdbId,
      malPosterUrl: fallbackBackgroundUrl,
      mediaType: type
    }, config, true)
  ]);

  return { background, poster, logo, imdbRatingValue, landscapePosterUrl };
}


const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

// --- Main Orchestrator ---
async function getMeta(type, language, stremioId, config = {}, userUUID, includeVideos = true) {
  try {
    // Validate inputs
    if (!stremioId || typeof stremioId !== 'string') {
      logger.error(`[Meta] Invalid stremioId: ${stremioId}`);
      return { meta: null };
    }
    
    // --- Handle custom ID prefixes (e.g., "tun_tt6128300") ---
    const isTraktUpNextId = stremioId.startsWith('tun_');
    if (isTraktUpNextId) {
      stremioId = stremioId.replace(/^tun_/, '');
    }
    const shouldIncludeVideos = !isTraktUpNextId && includeVideos;
    // --- TVDB Collections Meta Handler ---
    logger.debug(`[Meta] Starting process for ${stremioId} (type: ${type}, language: ${language})`);
    const [prefix, sourceId] = stremioId.split(':');
    if (prefix === 'tvdbc') {
      return await handleTvdbCollection(sourceId, language, config, userUUID);
    }
    let meta;
    logger.debug(`[Meta] Processing ${stremioId} (type: ${type})`);

    let isImdbIdAnime = false;
    if (stremioId.startsWith('tt')) {
        const fribbMapping = idMapper.getMappingByImdbId(stremioId);
        const traktMapping = type === 'movie' ? idMapper.getTraktAnimeMovieByImdbId(stremioId) : null;
        isImdbIdAnime = !!fribbMapping || !!traktMapping;
    }
    
    let isTmdbIdAnime = false;
    if (stremioId.startsWith('tmdb:')) {
        const tmdbId = stremioId.replace('tmdb:', '');
        const fribbMapping = idMapper.getMappingByTmdbId(tmdbId, type);
        const traktMapping = type === 'movie' ? idMapper.getTraktAnimeMovieByTmdbId(tmdbId) : null;
        isTmdbIdAnime = !!fribbMapping || !!traktMapping;
    }
    
    let isTvdbIdAnime = false;
    if (stremioId.startsWith('tvdb:')) {
        const tvdbId = stremioId.replace('tvdb:', '');
        if (type !== 'movie') {
             const fribbMapping = idMapper.getMappingByTvdbId(tvdbId);
             if (fribbMapping) isTvdbIdAnime = true;
        } 
        else {
            const wikiMap = wikiMappings.getByTvdbId(tvdbId);
            if (wikiMap && wikiMap.imdbId) {
                const traktMapping = idMapper.getTraktAnimeMovieByImdbId(wikiMap.imdbId);
                if (traktMapping) {
                    isTvdbIdAnime = true;
                }
            }
        }
    }

    // Combined Check
    const isAnime = stremioId.startsWith('mal:') ||
                    stremioId.startsWith('kitsu:') ||
                    stremioId.startsWith('anidb:') ||
                    stremioId.startsWith('anilist:') ||
                    (isImdbIdAnime && config.providers?.forceAnimeForDetectedImdb) ||
                    (isTmdbIdAnime && config.providers?.forceAnimeForDetectedImdb) ||
                    (isTvdbIdAnime && config.providers?.forceAnimeForDetectedImdb);
    const finalType = isAnime ? 'anime' : type;
    let preferredProvider;
    if (finalType === 'movie') {
      preferredProvider = config.providers?.movie || 'tmdb';
    } else if (finalType === 'series') {
      preferredProvider = config.providers?.series || 'tvdb';
    } else if (finalType === 'anime') {
      preferredProvider = config.providers?.anime || 'mal';
    }
    const posterProvider = Utils.resolveArtProvider(finalType, 'poster', config);
    const backgroundProvider = Utils.resolveArtProvider(finalType, 'background', config);
    const logoProvider = Utils.resolveArtProvider(finalType, 'logo', config);
    // Helper function to map art providers to their required metadata providers
    const getMetadataProvidersForArtProvider = (artProvider, contentType) => {
      switch (artProvider) {
        case 'fanart':
          // Fanart.tv requires TMDB ID for movies, TVDB ID for series/anime
          return contentType === 'movie' ? ['tmdb', 'imdb'] : ['tvdb'];
        case 'tmdb':
          return ['tmdb'];
        case 'tvdb':
          return ['tvdb'];
        case 'imdb':
          return ['imdb'];
        case 'tvmaze':
          return ['tvmaze'];
        default:
          // For unknown art providers, return empty array
          return [];
      }
    };

    const targetProviders = new Set();
    targetProviders.add(preferredProvider);
    
    // Add metadata providers needed for art providers
    const artProviders = [posterProvider, backgroundProvider, logoProvider];
    for (const artProvider of artProviders) {
      if (artProvider !== preferredProvider) {
        const requiredProviders = getMetadataProvidersForArtProvider(artProvider, type);
        for (const provider of requiredProviders) {
            targetProviders.add(provider);
        }
      }
    }
    
    if(!targetProviders.has('imdb')) {
      targetProviders.add('imdb');
    }
    if(preferredProvider === 'tvmaze' && config.ageRating.toLowerCase() !== 'none' && !targetProviders.has('tmdb')) {
      targetProviders.add('tmdb');
    }
    if(!targetProviders.has(preferredProvider)) {
      targetProviders.add(preferredProvider);
    }
    logger.debug(`[Meta] Target providers: ${Array.from(targetProviders)}`);
    const allIds =  await resolveAllIds(stremioId, type, config, {}, Array.from(targetProviders));
    switch (finalType) {
      case 'movie':
        meta = await getMovieMeta(stremioId, preferredProvider, language, config, userUUID, allIds);
        break;
      case 'series':
        meta = await getSeriesMeta(preferredProvider, stremioId, language, config, userUUID, allIds, shouldIncludeVideos);
        break;
      case 'anime':
        meta = await getAnimeMeta(config.providers?.anime, stremioId, language, config, userUUID, allIds, type, isAnime, shouldIncludeVideos);
        break;
    }

    // Check if meta was successfully retrieved
    if (!meta) {
      logger.debug(`[Meta] No metadata found for ${stremioId}`);
      return { meta: null };
    }

    if(isTraktUpNextId) {
      // Legacy support for external Trakt Up Next addon (tun_ prefix)
      if(meta.id && meta.id.startsWith('tt')) {
        meta.id = `tun_${meta.id}`;
      }
    }
    return { meta };
  } catch (error) {
    logger.error(`Failed to get meta for ${type} with ID ${stremioId}:`, error);
    return { meta: null };
  }
}

// Extracted TVDB collection handler
async function handleTvdbCollection(collectionId, language, config, userUUID) {
  return await cacheWrapMeta(
    userUUID || '',
    `tvdbc:${collectionId}`,
    async () => {
      const details = await tvdb.getCollectionDetails(collectionId, config);
      if (!details || !Array.isArray(details.entities)) return { meta: null };

      const langCode = language.split('-')[0];
      const langCode3 = await to3LetterCode(langCode, config);

      // Get translation with fallback
      let translation = await tvdb.getCollectionTranslations(collectionId, langCode3, config);
      if (!translation?.name) {
        translation = await tvdb.getCollectionTranslations(collectionId, 'eng', config);
      }

      const name = translation?.name || details.name;
      const overview = translation?.overview || details.overview;
      const poster = details.image 
        ? (details.image.startsWith('http') ? details.image : `${TVDB_IMAGE_BASE}${details.image}`)
        : undefined;
      let genres = (details.tags || []).filter(t => t.tagName === "Genre").map(t => t.name);

      const movieEntities = details.entities.filter(e => e.movieId);
      const seriesEntities = []; // Filter out series - collections are movies only

      // Process entities in parallel
      const { videos, links, background, genreSet } = await processCollectionEntities(
        movieEntities, 
        seriesEntities, 
        langCode3, 
        config, 
        userUUID,
        language  // Pass language for episode fetching
      );

      // Fallback genres from items
      if (!genres.length && genreSet.size) {
        genres = Array.from(genreSet);
      }

      // Add genre links
      if (genres.length) {
        const genreType = 'movie'; 
        const genreLinks = Utils.parseGenreLink(genres.map(name => ({ name })), genreType, userUUID, true);
        const seen = new Set();
        for (const link of genreLinks) {
          const key = `${link.name}|${link.category}|${link.url}`;
          if (!seen.has(key)) {
            links.push(link);
            seen.add(key);
          }
        }
      }

      return {
        meta: {
          id: `tvdbc:${collectionId}`,
          type: 'movie', 
          name,
          description: Utils.addMetaProviderAttribution(overview, 'TVDB', config),
          poster,
          background,
          genres: genres.length > 0 ? genres : [],
          videos,
          shouldIncludeVideos: true,
          links: links.length > 0 ? links : []
        }
      };
    },
    12 * 60 * 60,
    {},
    'movie'
  );
}

async function processCollectionEntities(movieEntities, seriesEntities, langCode3, config, userUUID, language) {
  const videos = [];
  const links = [];
  const genreSet = new Set();
  let background = undefined;
  let movieEpisodeNum = 1;

  // Process all movies/series in parallel batches
  if (movieEntities.length && !seriesEntities.length) {
    // All movies
    const movieResults = await Promise.allSettled(
      movieEntities.map(entity => processMovieEntity(entity, langCode3, config))
    );

    for (const result of movieResults) {
      if (result.status === 'fulfilled' && result.value) {
        const { video, genres } = result.value;
        if (video) {
          video.episode = movieEpisodeNum++;
          videos.push(video);
        }
        genres.forEach(g => genreSet.add(g));
      }
    }

    // Get background from first movie
    if (movieEntities[0]) {
      background = await tvdb.getMovieBackground(movieEntities[0].movieId, config).catch(() => undefined);
    }
  } else if (!movieEntities.length && seriesEntities.length) {
    // All series: first as videos, rest as links
    const [firstSeries, ...otherSeries] = seriesEntities;
    
    if (firstSeries) {
      const [seriesData, episodesData] = await Promise.all([
        tvdb.getSeriesExtended(firstSeries.seriesId, config),
        tvdb.getSeriesEpisodes(firstSeries.seriesId, language, config.tvdbSeasonType, config)
      ]);

      if (seriesData) {
        collectGenresFromItems([seriesData]).forEach(g => genreSet.add(g));
        background = await tvdb.getSeriesBackground(firstSeries.seriesId, config).catch(() => undefined);

        const allIds = await resolveAllIds(`tvdb:${firstSeries.seriesId}`, 'series', config);
        const episodes = episodesData?.episodes || [];

        for (const ep of episodes) {
          videos.push({
            id: `${allIds?.imdbId || `tvdb:${firstSeries.seriesId}`}:${ep.seasonNumber}:${ep.number}`,
            title: ep.name || `Episode ${ep.episode_number}`,
            season: ep.seasonNumber,
            episode: ep.number,
            overview: ep.overview,
            thumbnail: ep.image ? (ep.image.startsWith('http') ? ep.image : `${TVDB_IMAGE_BASE}${ep.image}`) : `${host}/missing_thumbnail.png`,
            released: ep.aired ? createDateInTimezone(ep.aired, config.timezone || 'UTC').toISOString() : null,
            available: ep.aired ? new Date(ep.aired) < new Date() : false
          });
        }
      }
    }

    // Process other series as links in parallel
    const seriesLinkResults = await Promise.allSettled(
      otherSeries.map(entity => processSeriesLink(entity, langCode3, config, genreSet))
    );

    for (const result of seriesLinkResults) {
      if (result.status === 'fulfilled' && result.value) {
        links.push(result.value);
      }
    }
  } else if (movieEntities.length && seriesEntities.length) {
    // Mixed: movies as videos, series as links
    const [movieResults, seriesResults] = await Promise.all([
      Promise.allSettled(movieEntities.map(e => processMovieEntity(e, langCode3, config))),
      Promise.allSettled(seriesEntities.map(e => processSeriesLink(e, langCode3, config, genreSet)))
    ]);

    for (const result of movieResults) {
      if (result.status === 'fulfilled' && result.value) {
        const { video, genres } = result.value;
        if (video) {
          video.episode = movieEpisodeNum++;
          videos.push(video);
        }
        genres.forEach(g => genreSet.add(g));
      }
    }

    for (const result of seriesResults) {
      if (result.status === 'fulfilled' && result.value) {
        links.push(result.value);
      }
    }

    if (movieEntities[0]) {
      background = await tvdb.getMovieBackground(movieEntities[0].movieId, config).catch(() => undefined);
    }
  }

  return { videos, links: links.filter(Boolean), background, genreSet };
}

// Helper to process a single movie entity
async function processMovieEntity(entity, langCode3, config) {
  const movie = await tvdb.getMovieExtended(entity.movieId, config);
  if (!movie) return null;

  const allIds = await resolveAllIds(`tvdb:${entity.movieId}`, 'movie', config, {}, ['imdb']);

  const nameTranslations = movie.translations?.nameTranslations || [];
  const translatedName = nameTranslations.find(t => t.language === langCode3)?.name
             || nameTranslations.find(t => t.language === 'eng')?.name
             || movie.name;
  const overviewTranslations = movie.translations?.overviewTranslations || [];
  const translatedOverview = overviewTranslations.find(t => t.language === langCode3)?.overview
    || overviewTranslations.find(t => t.language === 'eng')?.overview
    || movie.overview;

    const tvdbPosterUrl = findArtwork(movie.artworks, 14, langCode3, config, 'thumbnail') || findArtwork(movie.artworks, 14, langCode3, config, 'image') || `${host}/missing_thumbnail.png`;
  return {
    video: {
      id: allIds?.imdbId || `tvdb:${entity.movieId}`,
      title: translatedName,
      season: 1,
      episode: 0, // Will be set by caller
      overview: translatedOverview,
      thumbnail: tvdbPosterUrl,
      released: movie.first_release?.Date ? createDateInTimezone(movie.first_release.Date, config.timezone || 'UTC').toISOString() : null,
      available: movie.first_release?.Date ? new Date(movie.first_release.Date) < new Date() : false
    },
    genres: movie.genres?.map(g => g.name) || []
  };
}

// Helper to process a series link
async function processSeriesLink(entity, langCode3, config, genreSet) {
  const series = await tvdb.getSeriesExtended(entity.seriesId, config);
  if (!series) return null;

  collectGenresFromItems([series]).forEach(g => genreSet.add(g));

  const nameTranslations = series.translations?.nameTranslations || [];
  const translatedName = nameTranslations.find(t => t.language === langCode3)?.name
    || nameTranslations.find(t => t.language === 'eng')?.name
    || series.name;

  const allIds = await resolveAllIds(`tvdb:${entity.seriesId}`, 'series', config, {}, ['imdb']);
  let stremioId = `tvdb:${entity.seriesId}`;
  if(allIds.imdbId) {
    stremioId = allIds.imdbId;
  }

  return {
    name: translatedName || `Series ${entity.seriesId}`,
    url: `stremio:///detail/series/${stremioId}`,
    category: "SeriesCollection"
  };
}

function collectGenresFromItems(items) {
  const genreSet = new Set();
  for (const item of items) {
    if (item?.genres) {
      for (const g of item.genres) {
        if (g?.name) genreSet.add(g.name);
      }
    }
  }
  return genreSet;
}

// --- Movie Worker ---
async function getMovieMeta(stremioId, preferredProvider, language, config, userUUID, allIds) {
  logger.debug(`[MovieMeta] Starting process for ${stremioId}. Preferred: ${preferredProvider}`);
  
  // Try preferred provider first
  if (preferredProvider === 'tvdb' && allIds?.tvdbId) {
    try {
      const movieData = await tvdb.getMovieExtended(allIds.tvdbId, config);
      if (movieData) {
        return await buildTvdbMovieResponse(stremioId, movieData, language, config, userUUID, { allIds });
      } else {
        logger.warn(`[MovieMeta] TVDB returned null data for ${allIds.tvdbId}`);
      }
    } catch (e) {
      logger.warn(`[MovieMeta] Preferred provider 'tvdb' failed for ${stremioId}: ${e.message}`);
    }
  }

  if (allIds?.imdbId && preferredProvider === 'imdb') {
    try {
      const imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'movie');
      if (imdbData) {
        return await buildImdbMovieResponse(stremioId, imdbData, { allIds }, config);
      } else {
        logger.warn(`[MovieMeta] IMDB returned null data for ${allIds.imdbId}`);
      }
    } catch (e) {
      logger.warn(`[MovieMeta] Preferred provider 'imdb' failed for ${stremioId}: ${e.message}`);
    }
  }

  // Try TMDB as fallback
  if (allIds?.tmdbId) {
    try {
      const langCode = language.split('-')[0];
      const imageLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
      const videoLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
      const movieData = await moviedb.movieInfo({ 
        id: allIds.tmdbId, 
        language, 
        append_to_response: "videos,credits,external_ids,images,translations,watch/providers,release_dates", 
        include_image_language: imageLanguages,
        include_video_language: videoLanguages
      }, config);
      
      if (movieData) {
        return await buildTmdbMovieResponse(stremioId, movieData, language, config, userUUID, { allIds });
      } else {
        logger.warn(`[MovieMeta] TMDB returned null data for ${allIds.tmdbId}`);
      }
    } catch (e) {
      logger.warn(`[MovieMeta] TMDB fallback failed for ${stremioId}: ${e.message}`);
    }
  }

  // Try provider from stremioId
  const [provider, id] = stremioId.startsWith('tt') ? ['imdb', stremioId] : stremioId.split(':');
  
  if (provider === 'tvdb' && id) {
    try {
      const movieData = await tvdb.getMovieExtended(id, config);
      if (movieData) {
        return await buildTvdbMovieResponse(stremioId, movieData, language, config, userUUID, { allIds });
      } else {
        logger.warn(`[MovieMeta] TVDB by ID returned null data for ${id}`);
      }
    } catch (e) {
      logger.warn(`[MovieMeta] TVDB by ID failed: ${e.message}`);
    }
  } else if (provider === 'imdb' && id) {
    try {
      const movieData = await imdb.getMetaFromImdb(id, 'movie');
      if (movieData) {
        return await buildImdbMovieResponse(stremioId, movieData, { allIds }, config);
      } else {
        logger.warn(`[MovieMeta] IMDB by ID returned null data for ${id}`);
      }
    } catch (e) {
      logger.warn(`[MovieMeta] IMDB by ID failed: ${e.message}`);
    }
  }
  
  return null;
}

async function getSeriesMeta(preferredProvider, stremioId, language, config, userUUID, allIds, includeVideos) {
  logger.debug(`[SeriesMeta] Starting process for ${stremioId}. Preferred: ${preferredProvider}`);

  // Try preferred provider
  if (preferredProvider === 'tmdb' && allIds?.tmdbId) {
    try {
      const langCode = language.split('-')[0];
      const imageLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
      const videoLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
      const seriesData = await moviedb.tvInfo({ 
        id: allIds.tmdbId, 
        language, 
        append_to_response: "videos,credits,external_ids,images,translations,watch/providers,content_ratings", 
        include_image_language: imageLanguages,
        include_video_language: videoLanguages
      }, config);
      
      if (seriesData) {
        return await buildTmdbSeriesResponse(stremioId, seriesData, language, config, userUUID, { allIds }, false, includeVideos);
      } else {
        logger.warn(`[SeriesMeta] TMDB returned null data for ${allIds.tmdbId}`);
      }
    } catch (e) {
      const errorLine = e.stack?.split('\n')[1]?.trim() || 'unknown';
      logger.warn(`[SeriesMeta] TMDB failed: ${e.message}`);
      logger.warn(`[SeriesMeta] TMDB error at: ${errorLine}`);
      logger.warn(`[SeriesMeta] TMDB full stack trace:`, e.stack);
    }
  }

  if (allIds?.imdbId && preferredProvider === 'imdb') {
    try {
      const imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'series');
      if (imdbData) {
        return await buildImdbSeriesResponse(stremioId, imdbData, { allIds }, config);
      } else {
        logger.warn(`[SeriesMeta] IMDB returned null data for ${allIds.imdbId}`);
      }
    } catch (e) {
      logger.warn(`[SeriesMeta] IMDB failed: ${e.message}`);
    }
  }

  if (preferredProvider === 'tvmaze' && allIds?.tvmazeId) {
    try {
      const [seriesData, episodes] = await Promise.all([
        tvmaze.getShowDetails(allIds.tvmazeId),
        includeVideos ? tvmaze.getShowEpisodes(allIds.tvmazeId) : null
      ]);
      
      if (seriesData) {
        return await buildSeriesResponseFromTvmaze(stremioId, seriesData, episodes, language, config, userUUID, { allIds }, false, includeVideos);
      } else {
        logger.warn(`[SeriesMeta] TVmaze returned null data for ${allIds.tvmazeId}`);
      }
    } catch (e) {
      logger.warn(`[SeriesMeta] TVmaze failed: ${e.message}`);
    }
  }

  // Try TVDB as fallback
  if (allIds?.tvdbId) {
    try {
      const [seriesData, episodes] = await Promise.all([
        tvdb.getSeriesExtended(allIds.tvdbId, config),
        includeVideos ? tvdb.getSeriesEpisodes(allIds.tvdbId, language, config.tvdbSeasonType, config) : null
      ]);
      
      // Check if we got valid data
      if (seriesData) {
        return await buildTvdbSeriesResponse(stremioId, seriesData, episodes, language, config, userUUID, { allIds }, false, includeVideos);
      } else {
        logger.debug(`[SeriesMeta] TVDB returned null data for ${allIds.tvdbId} (expected when content doesn't exist on TVDB)`);
      }
    } catch (e) {
      logger.warn(`[SeriesMeta] TVDB fallback failed: ${e.message}`);
    }
  }

  // Try provider from stremioId
  const [provider, id] = stremioId.startsWith('tt') ? ['imdb', stremioId] : stremioId.split(':');
  
  if (provider === 'tmdb' && id) {
    try {
      const langCode = language.split('-')[0];
      const imageLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
      const videoLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
      const seriesData = await moviedb.tvInfo({ 
        id, 
        language, 
        append_to_response: "videos,credits,external_ids,images,translations,watch/providers", 
        include_image_language: imageLanguages,
        include_video_language: videoLanguages
      }, config);
      
      if (seriesData) {
        return await buildTmdbSeriesResponse(stremioId, seriesData, language, config, userUUID, { allIds }, false, includeVideos);
      } else {
        logger.warn(`[SeriesMeta] TMDB by ID returned null data for ${id}`);
      }
    } catch (e) {
      const errorLine = e.stack?.split('\n')[1]?.trim() || 'unknown';
      logger.warn(`[SeriesMeta] TMDB by ID failed: ${e.message}`);
      logger.warn(`[SeriesMeta] TMDB by ID error at: ${errorLine}`);
      logger.warn(`[SeriesMeta] TMDB by ID full stack trace:`, e.stack);
    }
  } else if (provider === 'imdb' && id) {
    try {
      const seriesData = await imdb.getMetaFromImdb(id, 'series');
      if (seriesData) {
        return await buildImdbSeriesResponse(stremioId, seriesData, { allIds }, config);
      } else {
        logger.warn(`[SeriesMeta] IMDB by ID returned null data for ${id}`);
      }
    } catch (e) {
      logger.warn(`[SeriesMeta] IMDB by ID failed: ${e.message}`);
    }
  } else if (provider === 'tvmaze' && id) {
    try {
      const [seriesData, episodes] = await Promise.all([
        tvmaze.getShowDetails(id),
        includeVideos ? tvmaze.getShowEpisodes(id) : null
      ]);
      
      if (seriesData) {
        return await buildSeriesResponseFromTvmaze(stremioId, seriesData, episodes, language, config, userUUID, { allIds }, false, includeVideos);
      } else {
        logger.warn(`[SeriesMeta] TVmaze by ID returned null data for ${id}`);
      }
    } catch (e) {
      logger.warn(`[SeriesMeta] TVmaze by ID failed: ${e.message}`);
    }
  }

  return null;
}

// --- Anime worker ---

async function getAnimeMeta(preferredProvider, stremioId, language, config, userUUID, allIds, type, isAnime, includeVideos) {
  logger.debug(`[AnimeMeta] Starting process for ${stremioId}. Preferred: ${preferredProvider}`);

  if (type === 'movie') {
    if (allIds?.malId) {
      allIds.imdbId = idMapper.getTraktAnimeMovieByMalId(allIds.malId)?.externals.imdb;
      allIds.tmdbId = idMapper.getTraktAnimeMovieByMalId(allIds.malId)?.externals.tmdb;
      allIds.tvdbId = (wikiMappings.getByImdbId(allIds.imdbId, 'movie'))?.tvdbId || null;
    }
  }

  // --- Preferred Provider Logic ---
  try {
    if (preferredProvider && preferredProvider !== 'kitsu' && preferredProvider !== 'mal') {
      logger.debug(`[AnimeMeta] Attempting preferred provider '${preferredProvider}' for ${stremioId}.`);
      if (preferredProvider === 'tmdb' && allIds?.tmdbId) {
        const langCode = language.split('-')[0];
        const imageLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
        const videoLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
        if (type === 'movie') {
          const movieData = await moviedb.movieInfo({ id: allIds.tmdbId, language, append_to_response: "videos,credits,external_ids,images,translations,watch/providers", include_image_language: imageLanguages, include_video_language: videoLanguages }, config);
          if (movieData) {
          return await buildTmdbMovieResponse(stremioId, movieData, language, config, userUUID, { allIds }, isAnime);
          }
        } else {
          const seriesData = await moviedb.tvInfo({ id: allIds.tmdbId, language, append_to_response: "videos,credits,external_ids,images,translations,watch/providers", include_image_language: imageLanguages, include_video_language: videoLanguages }, config);
          if (seriesData) {
          return await buildTmdbSeriesResponse(stremioId, seriesData, language, config, userUUID, { allIds }, isAnime, includeVideos);
          }
        }
      }
      if (preferredProvider === 'tvdb' && allIds?.tvdbId) {
        if (type === 'series') {
          const [seriesData, episodes] = await Promise.all([
            tvdb.getSeriesExtended(allIds.tvdbId, config),
            includeVideos ? tvdb.getSeriesEpisodes(allIds.tvdbId, language, config.tvdbSeasonType, config) : null
          ]);
          if (!seriesData) {
            if (allIds?.imdbId) {
              let imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'series');
              return await buildImdbSeriesResponse(stremioId, imdbData, { allIds }, config, isAnime);
            }
          } else {
            return await buildTvdbSeriesResponse(stremioId, seriesData, episodes, language, config, userUUID, { allIds }, isAnime, includeVideos);
          }
        } else if (type === 'movie') {
          logger.debug(`[AnimeMeta] Attempting preferred provider TVDB with ID: ${allIds.tvdbId}`);
          const movieData = await tvdb.getMovieExtended(allIds.tvdbId, config);
          if (!movieData) {
            if (allIds?.imdbId) {
              let imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'movie');
              return await buildImdbMovieResponse(stremioId, imdbData, { allIds }, config, isAnime);
            }
          } else {
            return await buildTvdbMovieResponse(stremioId, movieData, language, config, userUUID, { allIds }, isAnime);
          }
        }
      }
      if (preferredProvider === 'tvmaze' && allIds?.tvmazeId) {
        const [seriesData, episodes] = await Promise.all([
          tvmaze.getShowDetails(allIds.tvmazeId),
          includeVideos ? tvmaze.getShowEpisodes(allIds.tvmazeId) : null
        ]);
        return await buildSeriesResponseFromTvmaze(stremioId, seriesData, episodes, language, config, userUUID, { allIds }, isAnime, includeVideos);
      }
      if (preferredProvider === 'imdb' && allIds?.imdbId) {
        if (type === 'series') {
          let imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'series');
          return await buildImdbSeriesResponse(stremioId, imdbData, { allIds }, config, isAnime);
        } else if (type === 'movie') {
          let imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'movie');
          return await buildImdbMovieResponse(stremioId, imdbData, { allIds }, config, isAnime);
        }
      }
      logger.debug(`[AnimeMeta] No ID found for preferred provider '${preferredProvider}'.`);
    }
  } catch (e) {
    logger.warn(`[AnimeMeta] Preferred provider '${preferredProvider}' failed for ${stremioId}. Falling back. Error: ${e.message}`);
    logger.error(`[AnimeMeta] Full error details:`, e);
  }

  // --- Fallback / Native Provider Logic ---

  // 1. Try Kitsu (if it's the preferred provider OR as a fallback, but not if MAL was the preferred provider)
  if (allIds?.kitsuId && (preferredProvider === 'kitsu' || preferredProvider !== 'mal')) {
    try {
      logger.debug(`[AnimeMeta] Using provider 'kitsu' for ${stremioId} (Kitsu ID: ${allIds.kitsuId})`);
      const kitsuDetails = await cacheWrapGlobal(
        `kitsu-anime-${allIds.kitsuId}-categories,episodes,mediaRelationships.destination`,
        () => kitsu.getMultipleAnimeDetails([allIds.kitsuId], 'categories,episodes,mediaRelationships.destination'),
        CATALOG_TTL
      );
      if (!kitsuDetails) {
        throw new Error(`Kitsu returned no details for Kitsu ID ${allIds.kitsuId}.`);
      }
      const details = kitsuDetails.data[0];
      const artwork = await getAnimeArtwork(allIds, config, details.attributes?.posterImage?.original, details.attributes?.coverImage?.original, type);
      const { background, poster, logo, landscapePosterUrl } = artwork;
      let episodes = kitsuDetails.included?.filter(item => item.type === 'episodes') || [];
      let genres = kitsuDetails.included?.filter(item => item.type === 'categories').map(item => item.attributes?.title).filter(Boolean) || [];
      return await buildKitsuAnimeResponse(stremioId, details, genres, kitsuDetails.included, episodes, config, userUUID, {
        mapping: allIds,
        bestBackgroundUrl: background,
        bestPosterUrl: poster,
        bestLogoUrl: logo,
        bestLandscapePosterUrl: landscapePosterUrl
      });
    } catch (kitsuError) {
      logger.warn(`[AnimeMeta] Kitsu provider failed: ${kitsuError.message}`);
    }
  }

  // 2. Try MAL (if it's the preferred provider OR as the final fallback)
  if (allIds?.malId) {
    try {
      logger.debug(`[AnimeMeta] Using provider 'mal' for ${stremioId}`);
      const [details, characters, episodes] = await Promise.all([
        cacheWrapJikanApi(`anime-details-${allIds.malId}`, () => jikan.getAnimeDetails(allIds.malId), null, { skipVersion: true }),
        includeVideos ? cacheWrapJikanApi(`anime-characters-${allIds.malId}`, () => jikan.getAnimeCharacters(allIds.malId), null, { skipVersion: true }) : null,
        includeVideos ? cacheWrapJikanApi(`anime-episodes-${allIds.malId}`, () => jikan.getAnimeEpisodes(allIds.malId), 24 * 60 * 60, { skipVersion: true }) : null,
      ]);
      if (!details) {
        throw new Error(`Jikan returned no core details for MAL ID ${allIds.malId}.`);
      }
      const artwork = await getAnimeArtwork(allIds, config, details.images?.jpg?.large_image_url, details.images?.jpg?.large_image_url, type);
      const { background, poster, logo, landscapePosterUrl } = artwork;
      return await buildAnimeResponse(stremioId, details, language, characters, episodes, config, userUUID, {
        mapping: allIds,
        bestBackgroundUrl: background,
        bestPosterUrl: poster,
        bestLogoUrl: logo,
        bestLandscapePosterUrl: landscapePosterUrl
      });
    } catch (malError) {
      logger.error(`[AnimeMeta] CRITICAL: Final fallback 'mal' also failed for ${stremioId}: ${malError.message}`);
    }
  }

  if (preferredProvider !== 'tmdb' && allIds?.tmdbId) {
    try {
      logger.debug(`[AnimeMeta] Falling back to TMDB for ${stremioId} (TMDB ID: ${allIds.tmdbId})`);
      const langCode = language.split('-')[0];
      const imageLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
      const videoLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
      if (type === 'movie') {
        const movieData = await moviedb.movieInfo({ id: allIds.tmdbId, language, append_to_response: "videos,credits,external_ids,images,translations,watch/providers", include_image_language: imageLanguages, include_video_language: videoLanguages }, config);
        if (movieData) {
          return await buildTmdbMovieResponse(stremioId, movieData, language, config, userUUID, { allIds }, isAnime);
        }
      } else {
        const seriesData = await moviedb.tvInfo({ id: allIds.tmdbId, language, append_to_response: "videos,credits,external_ids,images,translations,watch/providers", include_image_language: imageLanguages, include_video_language: videoLanguages }, config);
        if (seriesData) {
          return await buildTmdbSeriesResponse(stremioId, seriesData, language, config, userUUID, { allIds }, isAnime, includeVideos);
        }
      }
    } catch (tmdbError) {
      logger.warn(`[AnimeMeta] TMDB fallback failed for ${stremioId}: ${tmdbError.message}`);
    }
  }

  if (preferredProvider !== 'imdb' && allIds?.imdbId) {
    try {
      logger.debug(`[AnimeMeta] Falling back to IMDB for ${stremioId} (IMDB ID: ${allIds.imdbId})`);
      if (type === 'series') {
        const imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'series');
        if (imdbData) {
          return await buildImdbSeriesResponse(stremioId, imdbData, { allIds }, config, isAnime);
        }
      } else if (type === 'movie') {
        const imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'movie');
        if (imdbData) {
          return await buildImdbMovieResponse(stremioId, imdbData, { allIds }, config, isAnime);
        }
      }
    } catch (imdbError) {
      logger.warn(`[AnimeMeta] IMDB fallback failed for ${stremioId}: ${imdbError.message}`);
    }
  }

  return null;
}


// Optimized response builders with shared logic extraction

async function buildImdbSeriesResponse(stremioId, imdbData, enrichmentData = {}, config, isAnime = false) {
  // Guard against null imdbData
  if (!imdbData) {
    logger.error(`[ImdbSeriesMeta] imdbData is null for ${stremioId}`);
    return null;
  }

  const { allIds } = enrichmentData;
  const { tmdbId, tvdbId, imdbId } = allIds || {};
  const { poster: imdbPosterUrl, background: imdbBackgroundUrl, logo: imdbLogoUrl } = imdbData;

  let poster, background, logoUrl, landscapePosterUrl;

  const animeIdProviders = ['mal', 'anilist', 'kitsu', 'anidb'];
  // check if stremioId starts with one of the animeIdProviders
  if (isAnime && animeIdProviders.some(provider => stremioId.startsWith(provider))) {
    const artwork = await getAnimeArtwork(allIds, config, imdbPosterUrl, imdbBackgroundUrl, 'series');
    poster = artwork.poster;
    background = artwork.background;
    logoUrl = artwork.logo;
    landscapePosterUrl = artwork.landscapePosterUrl;
  } else {
    [poster, background, logoUrl, landscapePosterUrl] = await Promise.all([
      Utils.getSeriesPoster({ tmdbId, tvdbId, imdbId, metaProvider: 'imdb', fallbackPosterUrl: imdbPosterUrl }, config),
      Utils.getSeriesBackground({ tmdbId, tvdbId, imdbId, metaProvider: 'imdb', fallbackBackgroundUrl: imdbBackgroundUrl }, config),
      Utils.getSeriesLogo({ tmdbId, tvdbId, imdbId, metaProvider: 'imdb', fallbackLogoUrl: imdbLogoUrl }, config),
      Utils.getSeriesBackground({ tmdbId, tvdbId, imdbId, metaProvider: 'imdb', fallbackPosterUrl: landscapePosterUrl }, config, true)
    ]);
  }

  const fallbackPosterUrl = poster || `${host}/missing_poster.png`;
  const posterProxyUrl = Utils.buildPosterProxyUrl(host, 'series', `imdb:${imdbId}`, fallbackPosterUrl, config.language, config);

  const _rawPosterUrl = fallbackPosterUrl;
  // Process credits in place
  processCreditsPhotos(imdbData.credits_cast);
  processCreditsPhotos(imdbData.credits_crew);

  imdbData.poster = posterProxyUrl || `${host}/missing_poster.png`;
  imdbData.background = background;
  imdbData.logo = logoUrl;
  imdbData._rawPosterUrl = _rawPosterUrl;
  if (imdbData.description) {
    imdbData.description = Utils.addMetaProviderAttribution(imdbData.description, 'IMDB', config);
  }
  if (tmdbId){
    const langCode = config.language.split('-')[0];
    const videoLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
    const seriesData = await moviedb.tvInfo({ id: tmdbId, language: config.language, append_to_response: "content_ratings,videos", include_video_language: videoLanguages }, config);
    imdbData.app_extras = imdbData.app_extras || {};
    if(seriesData){
      const certification = Utils.getTmdbTvCertificationForCountry(seriesData.content_ratings);
      imdbData.app_extras.certification = certification;
      if (seriesData.videos) {
        const allTrailers = Utils.parseTrailers(seriesData.videos);
        const filteredTrailers = allTrailers.filter(trailer => trailer.lang === langCode);

        // Intelligent fallback: user language -> English -> all trailers
        const englishTrailers = allTrailers.filter(trailer => trailer.lang === 'en');
        const finalTrailers = filteredTrailers.length > 0 ? filteredTrailers : (englishTrailers.length > 0 ? englishTrailers : allTrailers);

        imdbData.trailers = finalTrailers;
      }
      if (certification && config.displayAgeRating) {
        const certificationLink = {
          name: certification,
          category: 'Genres',
          url: imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : `https://www.themoviedb.org/tv/${tmdbId}?language=${language}`
        };
        if (!Array.isArray(imdbData.links)) imdbData.links = [];
        imdbData.links.unshift(certificationLink);
      }
    }
  }

  // Process episode thumbnails with Top Poster API if enabled
  if (imdbData.videos && Array.isArray(imdbData.videos) && config.posterRatingProvider === 'top' && config.apiKeys?.topPoster && (tmdbId || imdbId)) {
    imdbData.videos = imdbData.videos.map(video => {
      // Extract season and episode from video ID (format: "imdbId:season:episode")
      const idParts = video.id?.split(':');
      if (idParts && idParts.length >= 3) {
        const season = parseInt(idParts[1], 10);
        const episode = parseInt(idParts[2], 10);
        
        if (!isNaN(season) && !isNaN(episode)) {
          // Pass blur option to Top Poster API when blurThumbs is enabled
          const topPosterThumbnail = Utils.getTopPosterThumbnail(
            config,
            { tmdbId, imdbId },
            season,
            episode,
            config.apiKeys.topPoster,
            'w500', // Use w500 resolution
            video.thumbnail || null,
            { blur: config.blurThumbs || false }
          );
          
          if (topPosterThumbnail) {
            // Top Poster API handles blur, no need for local blur proxy
            return {
              ...video,
              thumbnail: topPosterThumbnail
            };
          }
        }
      }
      return video;
    });
  }

  return imdbData;
}

async function buildImdbMovieResponse(stremioId, imdbData, enrichmentData = {}, config, isAnime = false) {
  // Guard against null imdbData
  if (!imdbData) {
    logger.error(`[ImdbMovieMeta] imdbData is null for ${stremioId}`);
    return null;
  }

  const { allIds } = enrichmentData;
  const { tmdbId, tvdbId, imdbId } = allIds || {};
  const { poster: imdbPosterUrl, background: imdbBackgroundUrl, logo: imdbLogoUrl } = imdbData;

  let poster, background, logoUrl, landscapePosterUrl;

  const animeIdProviders = ['mal', 'anilist', 'kitsu', 'anidb'];
  // check if stremioId starts with one of the animeIdProviders
  if (isAnime && animeIdProviders.some(provider => stremioId.startsWith(provider))) {
    const artwork = await getAnimeArtwork(allIds, config, imdbPosterUrl, imdbBackgroundUrl, 'movie');
    poster = artwork.poster;
    background = artwork.background;
    logoUrl = artwork.logo;
    landscapePosterUrl = artwork.landscapePosterUrl;
  } else {
    [poster, background, logoUrl, landscapePosterUrl] = await Promise.all([
      Utils.getMoviePoster({ tmdbId, tvdbId, imdbId, metaProvider: 'imdb', fallbackPosterUrl: imdbPosterUrl }, config),
      Utils.getMovieBackground({ tmdbId, tvdbId, imdbId, metaProvider: 'imdb', fallbackBackgroundUrl: imdbBackgroundUrl }, config),
      Utils.getMovieLogo({ tmdbId, tvdbId, imdbId, metaProvider: 'imdb', fallbackLogoUrl: imdbLogoUrl }, config),
      Utils.getMovieBackground({ tmdbId, tvdbId, imdbId, metaProvider: 'imdb', fallbackBackgroundUrl: landscapePosterUrl }, config, true)
    ]);
  }

  const _rawPosterUrl = poster || `${host}/missing_poster.png`;
  const posterProxyUrl = Utils.buildPosterProxyUrl(host, 'movie', `imdb:${imdbId}`, poster, config.language, config);

  processCreditsPhotos(imdbData.credits_cast);
  processCreditsPhotos(imdbData.credits_crew);

  imdbData.poster = posterProxyUrl || `${host}/missing_poster.png`;
  imdbData.background = background;
  imdbData.logo = logoUrl;
  imdbData._rawPosterUrl = _rawPosterUrl;
  if (imdbData.description) {
    imdbData.description = Utils.addMetaProviderAttribution(imdbData.description, 'IMDB', config);
  }
  if (tmdbId){
    const langCode = config.language.split('-')[0];
    const videoLanguages = Array.from(new Set([langCode, 'en', 'null'])).join(',');
    const movieData = await moviedb.movieInfo({ id: tmdbId, language: config.language, append_to_response: "release_dates,videos", include_video_language: videoLanguages }, config);
    if (movieData) {
    imdbData.app_extras = imdbData.app_extras || {};
    imdbData.released = movieData.release_date ? createDateInTimezone(movieData.release_date, config.timezone || 'UTC') : null;
    imdbData.app_extras.releaseDates = movieData.release_dates;
    const certification = Utils.getTmdbMovieCertificationForCountry(movieData.release_dates); 
    imdbData.app_extras.certification = certification;
    if (certification && config.displayAgeRating) {
      const certificationLink = {
        name: certification,
        category: 'Genres',
        url: imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : `https://www.themoviedb.org/movie/${tmdbId}?language=${language}`
      };
      if (!Array.isArray(imdbData.links)) imdbData.links = [];
      imdbData.links.unshift(certificationLink);
    }
    if (movieData.videos) {
      const allTrailers = Utils.parseTrailers(movieData.videos);
      const allTrailerStreams = Utils.parseTrailerStream(movieData.videos);
      const filteredTrailers = allTrailers.filter(trailer => trailer.lang === langCode);
      const filteredTrailerStreams = allTrailerStreams.filter(trailer => trailer.lang === langCode);

      const englishTrailers = allTrailers.filter(trailer => trailer.lang === 'en');
      const englishTrailerStreams = allTrailerStreams.filter(trailer => trailer.lang === 'en');
      const finalTrailers = filteredTrailers.length > 0 ? filteredTrailers : (englishTrailers.length > 0 ? englishTrailers : allTrailers);
      const finalTrailerStreams = filteredTrailerStreams.length > 0 ? filteredTrailerStreams : (englishTrailerStreams.length > 0 ? englishTrailerStreams : allTrailerStreams);

      imdbData.trailers = finalTrailers;
      imdbData.trailerStreams = finalTrailerStreams;
      }
    }
  }

  return imdbData;
}

// Helper to process credits photos in place
function processCreditsPhotos(credits) {
  if (!Array.isArray(credits)) return;
  
  for (const person of credits) {
    if (person.profile_path && !person.profile_path.startsWith('http')) {
      person.profile_path = `https://image.tmdb.org/t/p/w276_and_h350_face${person.profile_path}`;
    }
  }
}

function shouldForceLatinTmdbCast(config) {
  if (!config?.tmdb?.forceLatinCastNames) return false;
  const lang = (config.language || 'en-US').toLowerCase();
  return !lang.startsWith('en');
}

async function ensureLatinTmdbCredits(mediaType, tmdbId, existingCredits, config) {
  if (!shouldForceLatinTmdbCast(config) || !tmdbId) {
    return existingCredits;
  }

  try {
    const englishCredits = mediaType === 'movie'
      ? await moviedb.movieCredits({ id: tmdbId, language: 'en-US' }, config)
      : await moviedb.tvCredits({ id: tmdbId, language: 'en-US' }, config);

    if (englishCredits && (Array.isArray(englishCredits.cast) || Array.isArray(englishCredits.crew))) {
      processCreditsPhotos(englishCredits.cast);
      processCreditsPhotos(englishCredits.crew);
      return englishCredits;
    }
  } catch (error) {
    logger.warn(`[TMDB] Failed to fetch English credits for ${mediaType} ${tmdbId}: ${error.message}`);
  }

  return existingCredits;
}

async function buildTmdbMovieResponse(stremioId, movieData, language, config, userUUID, enrichmentData = {}, isAnime = false) {
  const { allIds } = enrichmentData;
  const { id: tmdbId, title, external_ids, poster_path, backdrop_path, images, } = movieData;
  const imdbId = allIds?.imdbId;
  const tvdbId = allIds?.tvdbId;
  const castCount = config.castCount;
  const langCode = language.split('-')[0];
  let credits = await ensureLatinTmdbCredits('movie', tmdbId, movieData.credits, config);
  if (!credits) {
    credits = { cast: [], crew: [] };
  }
  // Get artwork based on art provider preference
  const selectedPoster = Utils.selectTmdbImageByLang(images?.posters, config);
  const tmdbPosterUrl = selectedPoster?.file_path ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${selectedPoster?.file_path}` : poster_path ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${poster_path}` : `${host}/missing_poster.png`;
  const selectedBg = images?.backdrops?.find(b => b.iso_639_1 === 'xx')
    || images?.backdrops?.find(b => b.iso_639_1 === null)
    || images?.backdrops?.find(b => b.iso_639_1 === langCode)
    || images?.backdrops?.[0];
  const selectedLandscapePoster = Utils.selectTmdbImageByLang(images?.backdrops, config);
  const tmdbLandscapePosterUrl = selectedLandscapePoster?.file_path ? `https://image.tmdb.org/t/p/original${selectedLandscapePoster?.file_path}` : null;
  const tmdbBackgroundUrl = selectedBg?.file_path ? `https://image.tmdb.org/t/p/original${selectedBg?.file_path}` : backdrop_path ? `https://image.tmdb.org/t/p/original${backdrop_path}` : null;
  const selectedLogo = Utils.selectTmdbImageByLang(images?.logos, config);
  let tmdbLogoUrl = selectedLogo?.file_path ? `https://image.tmdb.org/t/p/original${selectedLogo?.file_path}` : imdbId ? imdb.getLogoFromImdb(imdbId) : null;
  
  let poster, background, logoUrl, imdbRatingValue, landscapePosterUrl;
  
  if (isAnime) {
    const artwork = await getAnimeArtwork(allIds, config, tmdbPosterUrl, tmdbBackgroundUrl, 'movie');
    poster = artwork.poster;
    background = artwork.background;
    logoUrl = artwork.logo;
    imdbRatingValue = artwork.imdbRatingValue;
    landscapePosterUrl = artwork.landscapePosterUrl;
  } else {
    [poster, background, logoUrl, imdbRatingValue, landscapePosterUrl] = await Promise.all([
      Utils.getMoviePoster({ tmdbId, tvdbId, imdbId, metaProvider: 'tmdb', fallbackPosterUrl: tmdbPosterUrl }, config),
      Utils.getMovieBackground({ tmdbId, tvdbId, imdbId, metaProvider: 'tmdb', fallbackBackgroundUrl: tmdbBackgroundUrl }, config),
      Utils.getMovieLogo({ tmdbId, tvdbId, imdbId, metaProvider: 'tmdb', fallbackLogoUrl: tmdbLogoUrl }, config),
      getImdbRating(imdbId, 'movie'),
      Utils.getMovieBackground({ tmdbId, tvdbId, imdbId, metaProvider: 'tmdb', fallbackBackgroundUrl: tmdbLandscapePosterUrl }, config, true)
  ]);
  }
  
  const imdbRating = imdbRatingValue || movieData.vote_average?.toFixed(1) || "N/A";
  const posterProxyUrl = Utils.buildPosterProxyUrl(host, 'movie', `tmdb:${movieData.id}`, poster, language, config);
  const kitsuId = allIds?.kitsuId;
  const idProvider = config.providers?.movie || 'imdb';
  const _rawPosterUrl = poster || `${host}/missing_poster.png`;
  const directorLinks = !credits || !Array.isArray(credits.crew) ? [] : credits.crew.filter((x) => x.job === "Director").map(d => ({
    name: d.name,
    category: 'Directors',
    url: `stremio:///search?search=${d.name}`
  }));

  const writerLinks = !credits || !Array.isArray(credits.crew) ? [] : credits.crew.filter((x) => x.job === "Writer").map(w => ({
    name: w.name,
    category: 'Writers',
    url: `stremio:///search?search=${w.name}`
  }));
  
  const directorDetails = !credits || !Array.isArray(credits.crew) ? [] : credits.crew.filter((x) => x.job === "Director").map(d => ({
    name: d.name,
    character: d.name,
    photo: d.profile_path ? `https://image.tmdb.org/t/p/w276_and_h350_face${d.profile_path}` : null
  })).filter(d => d.name);

  const writerDetails = !credits || !Array.isArray(credits.crew) ? [] : credits.crew.filter((x) => x.job === "Writer").map(w => ({
    name: w.name,
    character: w.name,
    photo: w.profile_path ? `https://image.tmdb.org/t/p/w276_and_h350_face${w.profile_path}` : null
  })).filter(w => w.name);

  let overview = movieData.overview;
  overview = Utils.processOverviewTranslations(movieData.translations, language, overview);
  finalTitle = Utils.processTitleTranslations(
    movieData.translations,
    language,
    title,
    'movie',
    movieData.original_language,
    movieData.original_title
  );
  const certification = Utils.getTmdbMovieCertificationForCountry(movieData.release_dates);
  let links = Utils.buildLinks(imdbRating, imdbId, title, 'movie', movieData.genres, credits, language, castCount, userUUID);
  if (certification && config.displayAgeRating) {
    const certificationLink = {
      name: certification,
      category: 'Genres',
      url: imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : `https://www.themoviedb.org/movie/${tmdbId}?language=${language}`
    };
    // add certification link to links as first genre link
    links.unshift(certificationLink);
  }

  const allTrailers = Utils.parseTrailers(movieData.videos);
  const allTrailerStreams = Utils.parseTrailerStream(movieData.videos);
  const userLangTrailers = allTrailers.filter(trailer => trailer.lang === langCode);
  const userLangTrailerStreams = allTrailerStreams.filter(trailer => trailer.lang === langCode);
  const englishTrailers = allTrailers.filter(trailer => trailer.lang === 'en');
  const englishTrailerStreams = allTrailerStreams.filter(trailer => trailer.lang === 'en');

  // Prefer user's language, fallback to English, then all available
  const finalTrailers = userLangTrailers.length > 0 ? userLangTrailers : (englishTrailers.length > 0 ? englishTrailers : allTrailers);
  const finalTrailerStreams = userLangTrailerStreams.length > 0 ? userLangTrailerStreams : (englishTrailerStreams.length > 0 ? englishTrailerStreams : allTrailerStreams);

  return {
    id: imdbId || stremioId,
    type: 'movie',
    description: Utils.addMetaProviderAttribution(overview, 'TMDB', config),
    name: finalTitle,
    imdb_id: imdbId,  
    slug: Utils.parseSlug('movie', finalTitle, null, stremioId),
    genres: Utils.parseGenres(movieData.genres),
    director: castCount !== 0 ? Utils.parseDirector(credits).join(', ') : '',
    writer: castCount !== 0 ? Utils.parseWriter(credits).join(', ') : '',
    year: movieData.release_date ? movieData.release_date.substring(0, 4) : "",
    released: movieData.release_date ? createDateInTimezone(movieData.release_date, config.timezone || 'UTC') : null,
    releaseInfo: movieData.release_date ? movieData.release_date.substring(0, 4) : "",
    runtime: Utils.parseRunTime(movieData.runtime),
    country: Utils.parseCoutry(movieData.production_countries),
    imdbRating,
    poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : poster,
    _rawPosterUrl: _rawPosterUrl,
    background: background,
    landscapePoster: landscapePosterUrl,
    logo: processLogo(logoUrl),
    trailers: finalTrailers,
    trailerStreams: finalTrailerStreams,
    links: links,
    behaviorHints: { defaultVideoId: kitsuId && idProvider === 'kitsu' ? `kitsu:${kitsuId}` : imdbId || stremioId, hasScheduledVideos: false },
    app_extras: { cast: Utils.parseCast(credits, castCount), directors: castCount !== 0 ? directorDetails : [], writers: castCount !== 0 ? writerDetails : [], releaseDates: movieData.release_dates, certification: certification }
  };
}


async function buildTmdbSeriesResponse(stremioId, seriesData, language, config, userUUID, enrichmentData = {}, isAnime = false, includeVideos = true) {
  const { id: tmdbId, name, external_ids, poster_path, backdrop_path, videos: trailers, seasons, images } = seriesData;
  const { allIds } = enrichmentData;
  const imdbId = allIds?.imdbId;
  const tvdbId = allIds?.tvdbId;
  const kitsuId = allIds?.kitsuId;
  const malId = allIds?.malId;
  let credits = await ensureLatinTmdbCredits('tv', tmdbId, seriesData.credits, config);
  if (!credits) {
    credits = { cast: [], crew: [] };
  }

  let idProvider = config.providers?.anime_id_provider || 'imdb';
  if (idProvider === 'retain') {
    if (stremioId.startsWith('mal:')) idProvider = 'mal';
    else if (stremioId.startsWith('kitsu:')) idProvider = 'kitsu';
    else if (stremioId.startsWith('tt')) idProvider = 'imdb';
    else idProvider = 'imdb';
  }
  const langCode = language.split('-')[0];

  // Get artwork based on art provider preference
  const selectedPoster = Utils.selectTmdbImageByLang(images?.posters, config);
  const tmdbPosterUrl = selectedPoster?.file_path ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${selectedPoster?.file_path}` : poster_path ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${poster_path}` : `${host}/missing_poster.png`;
  const selectedBg = images?.backdrops?.find(b => b.iso_639_1 === 'xx')
    || images?.backdrops?.find(b => b.iso_639_1 === null)
    || images?.backdrops?.find(b => b.iso_639_1 === langCode)
    || images?.backdrops?.[0];
  const selectedLandscapePoster = Utils.selectTmdbImageByLang(images?.backdrops, config);
  const tmdbLandscapePosterUrl = selectedLandscapePoster?.file_path ? `https://image.tmdb.org/t/p/original${selectedLandscapePoster?.file_path}` : null;
  const tmdbBackgroundUrl = selectedBg?.file_path ? `https://image.tmdb.org/t/p/original${selectedBg?.file_path}` : backdrop_path ? `https://image.tmdb.org/t/p/original${backdrop_path}` : null;
  const selectedLogo = Utils.selectTmdbImageByLang(images?.logos, config);
  let tmdbLogoUrl = selectedLogo?.file_path ? `https://image.tmdb.org/t/p/original${selectedLogo?.file_path}` : imdbId ? imdb.getLogoFromImdb(imdbId) : null;
  let poster, background, logoUrl, imdbRatingValue, landscapePosterUrl;
  
  const animeIdProviders = ['mal', 'anilist', 'kitsu', 'anidb'];
  // check if stremioId starts with one of the animeIdProviders
  if (isAnime && animeIdProviders.some(provider => stremioId.startsWith(provider))) {
    const artwork = await getAnimeArtwork(allIds, config, tmdbPosterUrl, tmdbBackgroundUrl, 'series');
    poster = artwork.poster;
    background = artwork.background;
    logoUrl = artwork.logo;
    imdbRatingValue = artwork.imdbRatingValue;
    landscapePosterUrl = artwork.landscapePosterUrl;
  } else {
    [poster, background, logoUrl, imdbRatingValue, landscapePosterUrl] = await Promise.all([
      Utils.getSeriesPoster({ tmdbId, tvdbId, imdbId, metaProvider: 'tmdb', fallbackPosterUrl: tmdbPosterUrl }, config),
      Utils.getSeriesBackground({ tmdbId, tvdbId, imdbId, metaProvider: 'tmdb', fallbackBackgroundUrl: tmdbBackgroundUrl }, config),
      Utils.getSeriesLogo({ tmdbId, tvdbId, imdbId, metaProvider: 'tmdb', fallbackLogoUrl: tmdbLogoUrl }, config),
      getImdbRating(imdbId, 'series'),
      Utils.getSeriesBackground({ tmdbId, tvdbId, imdbId, metaProvider: 'tmdb', fallbackBackgroundUrl: tmdbLandscapePosterUrl }, config, true)
  ]);
  }
  // log arts 
  // logger.debug(`[TmdbSeriesMeta] poster: ${poster}, background: ${background}, logoUrl: ${logoUrl}`);
  
  const posterProxyUrl = Utils.buildPosterProxyUrl(host, 'series', `tmdb:${tmdbId}`, poster, language, config);
  const imdbRating = imdbRatingValue || seriesData.vote_average?.toFixed(1) || "N/A";
  const castCount = config.castCount;
  const _rawPosterUrl = poster || `${host}/missing_poster.png`;

  const directorLinks = !credits || !Array.isArray(credits.crew) ? [] : credits.crew.filter((x) => x.job === "Director").map(d => ({
    name: d.name,
    category: 'Directors',
    url: `stremio:///search?search=${d.name}`
  }));

  const writerLinks = !credits || !Array.isArray(credits.crew) ? [] : credits.crew.filter((x) => x.job === "Writer").map(w => ({
    name: w.name,
    category: 'Writers',
    url: `stremio:///search?search=${w.name}`
  }));
  
  const directorDetails = !credits || !Array.isArray(credits.crew) ? [] : credits.crew.filter((x) => x.job === "Director").map(d => ({
    name: d.name,
    character: d.name,
    photo: d.profile_path ? `https://image.tmdb.org/t/p/w276_and_h350_face${d.profile_path}` : null
  })).filter(d => d.name);

  const writerDetails = !credits || !Array.isArray(credits.crew) ? [] : credits.crew.filter((x) => x.job === "Writer").map(w => ({
    name: w.name,
    character: w.name,
    photo: w.profile_path ? `https://image.tmdb.org/t/p/w276_and_h350_face${w.profile_path}` : null
  })).filter(w => w.name);
  let videos = [];
  const tmdbSeasons = (seasons || []).filter(season => season.season_number != 0);
  const tmdbSeasonPosters = tmdbSeasons.map(season => {
    return season.poster_path ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${season.poster_path}` : null;
  });

  if(includeVideos) {
    const seasonToKitsuIdMap = new Map();
    const seasonToImdbIdMap = new Map();
    
    if (kitsuId && config.providers?.anime_id_provider === 'kitsu') {
      const officialSeasons = (seasons || [])
        .filter(season => season.season_number > 0 && season.episode_count > 0)
        .sort((a, b) => a.season_number - b.season_number);

      const kitsuMapPromises = officialSeasons.map(async (season) => {
        const seasonalKitsuId = await idMapper.resolveKitsuIdFromTmdbSeason(tmdbId, season.season_number);
        if (seasonalKitsuId) {
          seasonToKitsuIdMap.set(season.season_number, seasonalKitsuId);
        }
      });
      await Promise.all(kitsuMapPromises);
      logger.debug(`[ID Builder] Built Season-to-Kitsu map for tmdb:${tmdbId}:`, seasonToKitsuIdMap);
    }
    //console.log(`[TmdbSeriesMeta] credits: ${JSON.stringify(credits)}`);
    const imdbMeta = await imdb.getMetaFromImdb(imdbId, 'series', stremioId);

    // Fetch Cinemeta videos data for IMDB episode mapping (once per IMDB series)
    let cinemetaVideos = null;
      try {
        cinemetaVideos = imdbMeta?.videos || [];
        if (cinemetaVideos && cinemetaVideos.length > 0) {
          logger.debug(`[ID Builder] Fetched ${cinemetaVideos.length} Cinemeta videos for IMDB ${imdbId}`);
        }
      } catch (error) {
        logger.warn(`[ID Builder] Failed to fetch Cinemeta videos for IMDB ${imdbId}:`, error.message || error || 'Unknown error');
    }

    

    const seasonsString = Utils.genSeasonsString(seasons);
    const seasonPromises = seasonsString.map(el => moviedb.tvInfo({ id: tmdbId, language, append_to_response: el }, config));
    
    const imdbEpisodesCount = (cinemetaVideos || []).filter(season => season.season !==0).length;
    const seasonResponses = await Promise.all(seasonPromises);
    
    // Extract and combine all season data into an array
    const seasonDetails = [];
    seasonResponses.forEach(response => {
      Object.entries(response)
        .filter(([key]) => key.startsWith('season/'))
        .forEach(([key, seasonData]) => {
          seasonDetails.push(seasonData);
        });
    });
    const tmdbTotalEpisodes = seriesData.number_of_episodes;
    if (imdbEpisodesCount !== tmdbTotalEpisodes) {
      const imdbMeta = await imdb.getMetaFromImdb(imdbId, 'series', stremioId);
      if (imdbMeta) {
        const cinemetaIoVideos = (imdbMeta.videos || []).filter(episode => episode.season !== 0);
        if (cinemetaIoVideos.length > 0 && cinemetaIoVideos.length === tmdbTotalEpisodes) {
          cinemetaVideos = cinemetaIoVideos;
        }
      }
    }
    const isAnimeContent = isAnimeFunc(seriesData, seriesData.genres) || kitsuId || malId;
    logger.debug(`[TmdbSeriesMeta] isAnimeContent: ${isAnimeContent}`);
    
    const validImdbSeasons = new Set();
    const validTmdbSeasonsSet = new Set();
    if (cinemetaVideos && cinemetaVideos.length > 0) {
      const episodesBySeason = cinemetaVideos.reduce((acc, ep) => {
        if (ep.season > 0) { // Ignore season 0 specials
          if (!acc[ep.season]) acc[ep.season] = [];
          acc[ep.season].push(ep);
        }
        return acc;
      }, {});

      for (const seasonNum in episodesBySeason) {
        const hasReleasedEpisode = episodesBySeason[seasonNum].some(ep => ep.released || ep.firstAired);
        if (hasReleasedEpisode) {
          validImdbSeasons.add(parseInt(seasonNum, 10));
        }
      }
    }
    for (const season of tmdbSeasons) {
      if (season.season_number > 0 && season.air_date) {
        validTmdbSeasonsSet.add(season.season_number);
      }
    }
    const imdbSeasons = Array.from(validImdbSeasons);
    const validTmdbSeasons = Array.from(validTmdbSeasonsSet);

    logger.debug(`[TMDB] Filtered IMDB seasons to valid ones: ${imdbSeasons.length}`);
    // get season posters
    const tmdbSeasonNames = validTmdbSeasons.map(season => {
      // For anime, include series name for better specificity
      const seasonPattern = /^season\s+\d+$/i;
      if (validTmdbSeasons.length === 1) {
        return seriesData.name;
      }
      else {
        if (seasonPattern.test(season.name)) {
          // Generic season name like "Season 1", add series name
          return `${seriesData.name} ${season.name}`;
        } else {
          // Season name already has more specific info, use as is
          return season.name;
        }
      }
    });
    let resolvedImdbResults = [];
    let allTmdbSeasonsMapToSameImdb = false;
    
    if (validTmdbSeasons.length !== imdbSeasons.length) {
      // Only do name-to-imdb lookup when season counts don't match
      const imdbResults = tmdbSeasonNames.map(name => new Promise((resolve, reject) => {
        nameToImdb({ name: name, type: 'series' }, (err, result) => {
          if (err) {
            logger.warn(`[TMDB] Failed to get IMDB ID for season name "${name}": ${err?.message || err}`);
            resolve(null);
          } else {
            logger.debug(`[TMDB] IMDB ID for season name "${name}":`, result);
            resolve(result);
          }
        });
      }));
      
      resolvedImdbResults = await Promise.all(imdbResults);
      allTmdbSeasonsMapToSameImdb = resolvedImdbResults.every(id => id === resolvedImdbResults[0]);
    }
    logger.debug(`[TMDB] TMDB seasons: ${validTmdbSeasons.length}, IMDB seasons: ${imdbSeasons.length}`);
    
    // Only fetch IMDB videos if we have resolved IMDB results
    const imdbVideos = resolvedImdbResults.length > 0 
      ? await Promise.all(resolvedImdbResults.map(imdbId => idMapper.getCinemetaVideosForImdbSeries(imdbId)))
      : [];
    const videosPromises = seasonDetails.flatMap(season => 
      (season.episodes || []).map(async ep => {
        let episodeId = null; 
        if(ep.season_number === 0) {
          episodeId = `${imdbId || `tmdb:${tmdbId}`}:0:${ep.episode_number}`;
        } else {
          if (idProvider === 'kitsu' && kitsuId) {
            // Use season-specific Kitsu ID if available
            const seasonalKitsuId = seasonToKitsuIdMap.get(ep.season_number);
            if (seasonalKitsuId) {
              // Check if episode-level mapping is needed (like Dan Da Dan scenario)
              const franchiseInfo = await idMapper.getFranchiseInfoFromTmdbId(tmdbId);
              if (franchiseInfo && franchiseInfo.needsEpisodeMapping) {
                // Use episode-level mapping for this specific episode
                  const episodeMapping = await idMapper.resolveKitsuIdForEpisodeByTmdb(tmdbId, ep.season_number, ep.episode_number, ep.air_date);
                if (episodeMapping) {
                  episodeId = `kitsu:${episodeMapping.kitsuId}:${episodeMapping.episodeNumber}`;
                  logger.debug(`[ID Builder] Episode-level mapping: TMDB S${ep.season_number}E${ep.episode_number} → Kitsu ID ${episodeMapping.kitsuId} E${episodeMapping.episodeNumber}`);
                } else {
                  // Fallback to season-level mapping
                  episodeId = `kitsu:${seasonalKitsuId}:${ep.episode_number}`;
                }
              } else {
                // Use regular season-level mapping
                episodeId = `kitsu:${seasonalKitsuId}:${ep.episode_number}`;
              }
            }
          } 
          else if (idProvider === 'mal' && malId) {
            const seasonalKitsuId = seasonToKitsuIdMap.get(ep.season_number);
            const seasonalMalId = idMapper.getMappingByKitsuId(seasonalKitsuId)?.mal_id;
            if (seasonalMalId) {
              episodeId = `mal:${seasonalMalId}:${ep.episode_number}`;
            }
          }
          else {
            // Use episode-level IMDB mapping with air dates
              if (imdbId && cinemetaVideos.length > 0) {
                // check if tmdb and imdb have the same number of non 0 seasons and episodes

                if (validTmdbSeasons.length === imdbSeasons.length) {
                  episodeId = `${imdbId}:${ep.season_number}:${ep.episode_number}`;
                } else {
                  if (allTmdbSeasonsMapToSameImdb) {
                    logger.debug(`[ID Builder] All TMDB seasons map to the same IMDB ID`);
                    // Case 1: All TMDB seasons map to the same IMDB ID
                    const commonImdbId = resolvedImdbResults[0];
                    if (commonImdbId) {
                      // Find which TMDB season this episode belongs to
                      const tmdbSeason = validTmdbSeasons.find(s => s.season_number === ep.season_number);
                      const tmdbSeasonName = tmdbSeason ? tmdbSeason.name : `Season ${ep.season_number}`;
                      
                      const imdbEpisodeId = await idMapper.getImdbEpisodeIdFromTmdbEpisodeWhenAllSeasonsMapToSameImdb(
                        tmdbId,
                        ep.season_number,
                        ep.episode_number,
                        ep.air_date,
                        commonImdbId,
                        cinemetaVideos,
                        tmdbSeasonName
                      );
                      
                      if (imdbEpisodeId) {
                        episodeId = imdbEpisodeId;
                      } else {
                        // Fallback to TMDB ID
                        episodeId = `tmdb:${tmdbId}:${ep.season_number}:${ep.episode_number}`;
                      }
                      } else {
                            // Fallback to TMDB ID
                        episodeId = `tmdb:${tmdbId}:${ep.season_number}:${ep.episode_number}`;
                      }
                  }
                  else {
                    logger.debug(`[ID Builder] Different TMDB seasons map to different IMDB IDs`);
                    // Case 2: Different TMDB seasons map to different IMDB IDs
                    // Find the IMDB ID for this specific TMDB season
                    if(isAnimeContent) {
                      const tmdbSeason = validTmdbSeasons.find(s => s.season_number === ep.season_number);
                      const tmdbSeasonIndex = validTmdbSeasons.indexOf(tmdbSeason);
                      const seasonImdbId = resolvedImdbResults[tmdbSeasonIndex];
                      
                      if (seasonImdbId && imdbVideos[tmdbSeasonIndex]) {
                        // Use the specific IMDB videos for this season
                        const seasonImdbVideos = imdbVideos[tmdbSeasonIndex];
                        
                        // Try to find the episode in the specific IMDB series
                        const imdbEpisodeId = idMapper.getImdbEpisodeIdFromTmdbEpisode(
                          tmdbId,
                          ep.season_number,
                          ep.episode_number,
                          ep.air_date,
                          seasonImdbVideos,
                          seasonImdbId
                        );
                        
                        if (imdbEpisodeId) {
                          episodeId = imdbEpisodeId;
                        } else {
                          // Fallback to the specific IMDB ID
                          episodeId = `${seasonImdbId}:${ep.season_number}:${ep.episode_number}`;
                        }
                      } else {
                        episodeId = `tmdb:${tmdbId}:${ep.season_number}:${ep.episode_number}`;
                      }
                    } else {
                      // Non-anime content - use TMDB ID as fallback
                      episodeId = `tmdb:${tmdbId}:${ep.season_number}:${ep.episode_number}`;
                    }
                  }
                }
            }
          }
        }
        
        if (!episodeId) {
          episodeId = `tmdb:${tmdbId}:${ep.season_number}:${ep.episode_number}`;
        }

        // Use Top Poster API for episode thumbnails if enabled (Premium feature)
        let thumbnailUrl = null;
        let usingTopPoster = false;
        if (config.posterRatingProvider === 'top' && config.apiKeys?.topPoster && (tmdbId || imdbId)) {
          // Pass blur option to Top Poster API when blurThumbs is enabled
          const topPosterThumbnail = Utils.getTopPosterThumbnail(
            config,
            { tmdbId, imdbId },
            ep.season_number,
            ep.episode_number,
            config.apiKeys.topPoster,
            'w500', // Use w500 resolution to match TMDB default
            ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
            { blur: config.blurThumbs || false }
          );
          if (topPosterThumbnail) {
            thumbnailUrl = topPosterThumbnail;
            usingTopPoster = true;
          }
        }
        
        // Fallback to TMDB thumbnail if Top Poster not available
        if (!thumbnailUrl) {
          const isUnaired = !ep.air_date || createDateInTimezone(ep.air_date, config.timezone || 'UTC') > new Date();
          if (ep.still_path) {
            thumbnailUrl = `https://image.tmdb.org/t/p/w500${ep.still_path}`;
          } else if (isUnaired) {
            // For unaired episodes: try season poster, then background, then null
            const season = seasonDetails.find(s => s.season_number === ep.season_number) || seasons?.find(s => s.season_number === ep.season_number);
            if (background) {
              thumbnailUrl = background;
            }
            else if (season?.poster_path) {
              thumbnailUrl = `https://image.tmdb.org/t/p/w500${season.poster_path}`;
            } else {
              thumbnailUrl = null;
            }
          }  else {
    thumbnailUrl = background || `${host}/missing_thumbnail.png`;
}
        }
        
        // Only apply local blur proxy when NOT using Top Poster API (Top Poster handles blur itself)
        const finalThumbnail = thumbnailUrl && config.blurThumbs && !usingTopPoster && thumbnailUrl !== `${host}/missing_thumbnail.png`
          ? `${host}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}`
          : thumbnailUrl;
        
        return {
          id: episodeId,
          title: ep.name || `Episode ${ep.episode_number}`,
          season: ep.season_number,
          episode: ep.episode_number,
          released: ep.air_date ? createDateInTimezone(ep.air_date, config.timezone || 'UTC').toISOString() : null,
          overview: ep.overview,
          thumbnail: finalThumbnail,
          runtime: Utils.parseRunTime(ep.runtime),
        };
      })
    );

    
    videos = (await Promise.all(videosPromises)).filter(Boolean);
  }
  const runtime = seriesData.episode_run_time?.[0] ?? seriesData.last_episode_to_air?.runtime ?? seriesData.next_episode_to_air?.runtime ?? null;
  let overview = seriesData.overview;
  overview = Utils.processOverviewTranslations(seriesData.translations, language, overview);
  let finalName = seriesData.name;
  finalName = Utils.processTitleTranslations(
    seriesData.translations,
    language,
    finalName,
    'series',
    seriesData.original_language,
    seriesData.original_name
  );

  // Build releaseInfo in format "first_year-last_year" or "first_year-" for ongoing series
  let releaseInfo = "";
  if (seriesData.first_air_date) {
    const firstYear = seriesData.first_air_date.substring(0, 4);
    const isOngoing = seriesData.status === 'Returning Series' || seriesData.status === 'In Production' || seriesData.status === 'Planned';
    
    if (isOngoing || !seriesData.last_air_date) {
      releaseInfo = `${firstYear}-`;
    } else {
      const lastYear = seriesData.last_air_date.substring(0, 4);
      releaseInfo = firstYear === lastYear ? firstYear : `${firstYear}-${lastYear}`;
    }
  }

  const certification = Utils.getTmdbTvCertificationForCountry(seriesData.content_ratings);
  let links = [ ...Utils.buildLinks(imdbRating, imdbId, name, 'series', seriesData.genres, credits, language, castCount, userUUID)];
  if (castCount !== 0) {
    links.push(...directorLinks, ...writerLinks);
  }
  if (certification && config.displayAgeRating) {
    const certificationLink = {
      name: certification,
      category: 'Genres',
      url: imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : `https://www.themoviedb.org/tv/${tmdbId}?language=${language}`
    };
    links.unshift(certificationLink);
  }

  // Priority: User's language -> English (most common) -> All trailers
  const allTrailers = Utils.parseTrailers(trailers);
  const userLangTrailers = allTrailers.filter(trailer => trailer.lang === langCode);
  const englishTrailers = allTrailers.filter(trailer => trailer.lang === 'en');

  // Prefer user's language, fallback to English, then all available
  const finalTrailers = userLangTrailers.length > 0 ? userLangTrailers : (englishTrailers.length > 0 ? englishTrailers : allTrailers);

  logger.debug(`[TmdbSeriesMeta] imdbId: ${imdbId}, stremioId: ${stremioId}`);
  const meta = {
    id: imdbId || stremioId,
    type: 'series',
    name: finalName,
    imdb_id: imdbId,
    slug: Utils.parseSlug('series', finalName, null, stremioId),
    genres: Utils.parseGenres(seriesData.genres),
    description: Utils.addMetaProviderAttribution(overview, 'TMDB', config),
    year: seriesData.first_air_date ? seriesData.first_air_date.substring(0, 4) : "",
    releaseInfo: releaseInfo,
    released: seriesData.first_air_date ? createDateInTimezone(seriesData.first_air_date, config.timezone || 'UTC').toISOString() : null,
    status: seriesData.status,
    imdbRating,
    poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : poster,
    _rawPosterUrl: _rawPosterUrl,
    background: background,
    landscapePoster: landscapePosterUrl,
    logo: logoUrl,
    trailers: finalTrailers,
    links: links,
    videos: videos,
    behaviorHints: {
      defaultVideoId: null,
      hasScheduledVideos: true,
    },
    app_extras: { cast: Utils.parseCast(credits, castCount), directors: castCount !== 0 ? directorDetails : [], writers: castCount !== 0 ? writerDetails : [], seasonPosters: tmdbSeasonPosters, certification: certification }
  };
  if (runtime) {
    meta.runtime = Utils.parseRunTime(runtime);
  }
  return meta;
}

async function buildTvdbMovieResponse(stremioId, movieData, language, config, userUUID, enrichmentData = {}, isAnime = false) {
  const tvdbId = movieData.id;
  const { allIds } = enrichmentData;
  const kitsuId = allIds?.kitsuId;
  let imdbId = allIds?.imdbId;
  let tmdbId = allIds?.tmdbId;

  const { year, image: tvdbPosterPath, remoteIds, characters } = movieData;
  const langCode = language.split('-')[0];
  const langCode3 = await to3LetterCode(langCode, config);
  const nameTranslations = movieData.translations?.nameTranslations || [];
  const overviewTranslations = movieData.translations?.overviewTranslations || [];
  const translatedName = nameTranslations.find(t => t.language === langCode3)?.name
             || nameTranslations.find(t => t.language === 'eng')?.name
             || movieData.name;
  const overview = overviewTranslations.find(t => t.language === langCode3)?.overview
  || overviewTranslations.find(t => t.language === 'eng')?.overview
  || movieData.overview;
  
  let idProvider = config.providers?.anime_id_provider || 'kitsu';
  if (idProvider === 'retain') {
    if (stremioId.startsWith('mal:')) idProvider = 'mal';
    else if (stremioId.startsWith('kitsu:')) idProvider = 'kitsu';
    else if (stremioId.startsWith('tt')) idProvider = 'imdb';
    else idProvider = 'kitsu';
  }

  const castCount = config.castCount;

  // Get artwork based on art provider preference
  const tvdbPosterUrl = findArtwork(movieData.artworks, 14, langCode3, config) || `${host}/missing_poster.png`;
  const tvdbBackgroundUrl = findArtwork(movieData.artworks, 15, null, config);
  const tvdbLogoUrl = findArtwork(movieData.artworks, 25, langCode3, config);
  const tvdbLandscapePosterUrl = findArtwork(movieData.artworks, 15, langCode3, config);
  let poster, background, logoUrl, imdbRatingValue, landscapePosterUrl;
  
  const animeIdProviders = ['mal', 'anilist', 'kitsu', 'anidb'];
  // check if stremioId starts with one of the animeIdProviders
  if (isAnime && animeIdProviders.some(provider => stremioId.startsWith(provider))) {
    const artwork = await getAnimeArtwork(allIds, config, tvdbPosterUrl, tvdbBackgroundUrl, 'movie');
    poster = artwork.poster;
    background = artwork.background;
    logoUrl = artwork.logo;
    imdbRatingValue = artwork.imdbRatingValue;
    landscapePosterUrl = artwork.landscapePosterUrl;
  } else {
    [poster, background, logoUrl, imdbRatingValue, landscapePosterUrl] = await Promise.all([
      Utils.getMoviePoster({ tmdbId: tmdbId?.toString(), tvdbId: tvdbId?.toString(), imdbId: imdbId, metaProvider: 'tvdb', fallbackPosterUrl: tvdbPosterUrl }, config),
      Utils.getMovieBackground({ tmdbId: tmdbId?.toString(), tvdbId: tvdbId?.toString(), imdbId: imdbId, metaProvider: 'tvdb', fallbackBackgroundUrl: tvdbBackgroundUrl }, config),
      Utils.getMovieLogo({ tmdbId: tmdbId?.toString(), tvdbId: tvdbId?.toString(), imdbId: imdbId, metaProvider: 'tvdb', fallbackLogoUrl: tvdbLogoUrl }, config),
      getImdbRating(imdbId, 'movie'),
      Utils.getMovieBackground({ tmdbId: tmdbId?.toString(), tvdbId: tvdbId?.toString(), imdbId: imdbId, metaProvider: 'tvdb', fallbackBackgroundUrl: tvdbLandscapePosterUrl }, config, true)
    ]);
  }
  const imdbRating = imdbRatingValue || "N/A";
  
  const fallbackPosterUrl = poster || tvdbPosterUrl || `${host}/missing_poster.png`;
  const _rawPosterUrl = fallbackPosterUrl;
  const posterProxyUrl = Utils.buildPosterProxyUrl(host, 'movie', imdbId, fallbackPosterUrl, language, config);
  const movieCredits = {
    cast: (characters || [])
      .filter(c => c.peopleType === 'Actor')
      .map(c => ({
        name: c.personName,
        character: c.name,
        photo: c.image || c.personImgURL 
      }))
      .filter(c => c.name),
    crew: []
  };
  
  const directors = (characters || []).filter(c => c.peopleType === 'Director').map(c => c.personName).filter(Boolean);
  const writers = (characters || []).filter(c => c.peopleType === 'Writer').map(c => c.personName).filter(Boolean);


  const directorLinks = directors.map(d => ({
    name: d,
    category: 'Directors',
    url: `stremio:///search?search=${d}`
  }));

  const directorDetails = (characters || []).filter(c => c.peopleType === 'Director').map(d => ({
    name: d.personName,
    character: d.name,
    photo: d.image || d.personImgURL 
  })).filter(d => d.name);

  const writerDetails = (characters || []).filter(c => c.peopleType === 'Writer').map(w => ({
    name: w.personName,
    character: w.name,
    photo: w.image || w.personImgURL 
  })).filter(w => w.name);

  const writerLinks = writers.map(w => ({
    name: w,
    category: 'Writers',
    url: `stremio:///search?search=${w}`
  }));
  
  const { trailers, trailerStreams } = Utils.parseTvdbTrailers(movieData.trailers, translatedName);

  if(!logoUrl && imdbId){
    logoUrl =  imdb.getLogoFromImdb(imdbId);
  }


  let release_dates = null;
  let certification = null;
  if(tmdbId){
    const tmdbMovieData = await moviedb.movieInfo({ id: tmdbId, language, append_to_response: "release_dates" }, config);
    if (tmdbMovieData) {
      release_dates = tmdbMovieData.release_dates || null;  
    certification = Utils.getTmdbMovieCertificationForCountry(release_dates);
  }
  }
  let links = Utils.buildLinks(imdbRating, imdbId, translatedName, 'movie', movieData.genres, movieCredits, language, castCount, userUUID, true, 'tvdb');
  if (!Array.isArray(links)) links = [];
  else links = [...links];
  if (castCount !== 0) {
    links.push(...directorLinks, ...writerLinks);
  }
  if(certification && config.displayAgeRating){
    const certificationLink = {
      name: certification,
      category: 'Genres',
      url: imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : `https://www.thetvdb.com/movies/${movieData.slug}`
    };
    links.unshift(certificationLink);
  }
 
  //console.log(tvdbShow.artworks?.find(a => a.type === 2)?.image);
  return {
    id: isAnime ? config.mal?.useImdbIdForCatalogAndSearch ? imdbId : stremioId : imdbId || stremioId,
    type: 'movie',
    name: translatedName,
    imdb_id: imdbId,
    slug: Utils.parseSlug('movie', translatedName, null, stremioId),
    genres: movieData.genres?.map(g => g.name) || [],
    description: Utils.addMetaProviderAttribution(overview, 'TVDB', config),
    director: castCount !== 0 ? directors.join(', ') : '',
    writer: castCount !== 0 ? writers.join(', ') : '',
    year: year,
    releaseInfo: year,
    released: movieData.first_release.date ? createDateInTimezone(movieData.first_release.date, config.timezone || 'UTC').toISOString() : null,
    runtime: Utils.parseRunTime(movieData.runtime),
    country: movieData.originalCountry,
    imdbRating,
    poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : poster,
    _rawPosterUrl: _rawPosterUrl,
    background: background,
    landscapePoster: landscapePosterUrl,
    logo: processLogo(logoUrl),
    trailers: trailers,
    trailerStreams: trailerStreams,
    behaviorHints: {
      defaultVideoId: kitsuId && idProvider === 'kitsu' ? `kitsu:${kitsuId}` : imdbId ? imdbId : stremioId,
      hasScheduledVideos: false
    },
    links: links,
    app_extras: { cast: Utils.parseCast(movieCredits, castCount, 'tvdb'), directors: castCount !== 0 ? directorDetails : [], writers: castCount !== 0 ? writerDetails : [], releaseDates: release_dates, certification: certification }
  };
}

async function tvdbAbsoluteToImdbHelper(tvdbShow, config){
  const seasonLayoutMap = new Map(); 
      
  if (config.tvdbSeasonType === 'absolute') {
    const officialSeasons = (tvdbShow.seasons || [])
      .filter(s => s.type?.type === 'official' && s.number > 0)
      .sort((a, b) => a.number - b.number);

    const seasonDetailPromises = officialSeasons.map(s => tvdb.getSeasonExtended(s.id, config));
    const detailedSeasons = (await Promise.all(seasonDetailPromises)).filter(Boolean);

    let cumulativeEpisodes = 0;
    for (const season of detailedSeasons) {
      const episodeCount = season.episodes?.length || 0;
      const start = cumulativeEpisodes + 1;
      const end = cumulativeEpisodes + episodeCount;
      for (let i = start; i <= end; i++) {
        seasonLayoutMap.set(i, {
          seasonNumber: season.number,
          episodeNumber: i - start + 1
        });
      }
      cumulativeEpisodes = end;
    }
    logger.debug(`[ID Builder] Built absolute-to-seasonal map for tvdb:${tvdbShow.id}`);
  }
  return seasonLayoutMap;
}

function normalizeTvdbSeasons(seasons, episodes) {
  const hasYearSeasons = seasons.some(s => s.number > 1900);
  
  if (!hasYearSeasons) {
    return { seasons, episodes };
  }

  const sortedSeasons = [...seasons].sort((a, b) => a.number - b.number);
  
  const seasonMap = new Map();
  const normalizedSeasons = [];
  
  const specials = sortedSeasons.find(s => s.number === 0);
  if (specials) {
    normalizedSeasons.push(specials);
  }

  let seasonCounter = 1;
  sortedSeasons.forEach(season => {
    if (season.number === 0) return;
    
    seasonMap.set(season.number, seasonCounter);
    
    normalizedSeasons.push({
      ...season,
      number: seasonCounter,
      name: season.name || `Season ${seasonCounter} (${season.number})`
    });
    
    seasonCounter++;
  });

  const normalizedEpisodes = episodes.map(ep => {
    if (ep.seasonNumber === 0) return ep;
    
    const newSeasonNumber = seasonMap.get(ep.seasonNumber);
    if (newSeasonNumber) {
      return {
        ...ep,
        seasonNumber: newSeasonNumber,
        originalSeasonNumber: ep.seasonNumber
      };
    }
    return ep;
  });

  return { seasons: normalizedSeasons, episodes: normalizedEpisodes };
}



async function buildTvdbSeriesResponse(stremioId, tvdbShow, tvdbEpisodes, language, config, userUUID, enrichmentData = {}, isAnime = false, includeVideos = true) {
  const { year, image: tvdbPosterPath, remoteIds, characters, episodes } = tvdbShow;
  const { allIds } = enrichmentData;
  const kitsuId = allIds?.kitsuId;
  const langCode = language.split('-')[0];
  const langCode3 = await to3LetterCode(langCode, config);
  const nameTranslations = tvdbShow.translations?.nameTranslations || [];
  const overviewTranslations = tvdbShow.translations?.overviewTranslations || [];
  const translatedName = nameTranslations.find(t => t.language === langCode3)?.name
             || nameTranslations.find(t => t.language === 'eng')?.name
             || tvdbShow.name;
             
  const overview = overviewTranslations.find(t => t.language === langCode3)?.overview
                   || overviewTranslations.find(t => t.language === 'eng')?.overview
                   || tvdbShow.overview;
  let imdbId = allIds?.imdbId;
  const tmdbId = allIds?.tmdbId;
  const tvdbId = tvdbShow.id;
  const malId = allIds?.malId;
  const castCount = config.castCount;
  imdbId = imdbId || tvdbShow.remoteIds?.find(id => id.sourceName === 'IMDB')?.id

  // Get artwork based on art provider preference
  const tvdbPosterUrl = findArtwork(tvdbShow.artworks, 2, langCode3, config) || `${host}/missing_poster.png`;
  const tvdbBackgroundUrl = findArtwork(tvdbShow.artworks, 3, null, config);
  const tvdbLogoUrl = findArtwork(tvdbShow.artworks, 23, langCode3, config);
  const tvdbLandscapePosterUrl = findArtwork(tvdbShow.artworks, 3, langCode3, config);
  let poster, background, logoUrl, imdbRatingValue, landscapePosterUrl;
  // console log art provider preference
  const animeIdProviders = ['mal', 'anilist', 'kitsu', 'anidb'];
  // check if stremioId starts with one of the animeIdProviders
  if (isAnime && animeIdProviders.some(provider => stremioId.startsWith(provider))) {
    const artwork = await getAnimeArtwork(allIds, config, tvdbPosterUrl, tvdbBackgroundUrl, 'series');
    poster = artwork.poster;
    background = artwork.background;
    logoUrl = artwork.logo;
    imdbRatingValue = artwork.imdbRatingValue;
    landscapePosterUrl = artwork.landscapePosterUrl;
  } else {
    [poster, background, logoUrl, imdbRatingValue, landscapePosterUrl] = await Promise.all([
      Utils.getSeriesPoster({ tmdbId: tmdbId, tvdbId: tvdbId, imdbId: imdbId, metaProvider: 'tvdb', fallbackPosterUrl: tvdbPosterUrl }, config),
      Utils.getSeriesBackground({ tmdbId: tmdbId, tvdbId: tvdbId, imdbId: imdbId, metaProvider: 'tvdb', fallbackBackgroundUrl: tvdbBackgroundUrl }, config),
      Utils.getSeriesLogo({ tmdbId: tmdbId, tvdbId: tvdbId, imdbId: imdbId, metaProvider: 'tvdb', fallbackLogoUrl: tvdbLogoUrl }, config),
      getImdbRating(imdbId, 'series'),
      Utils.getSeriesBackground({ tmdbId: tmdbId, tvdbId: tvdbId, imdbId: imdbId, metaProvider: 'tvdb', fallbackBackgroundUrl: tvdbLandscapePosterUrl }, config, true)
  ]);
  }
  const imdbRating = imdbRatingValue || "N/A";
  const fallbackPosterUrl = poster || tvdbPosterUrl || `${host}/missing_poster.png`;
  const _rawPosterUrl = fallbackPosterUrl;
  // Top Poster API only supports IMDb and TMDB IDs, not TVDB
  // Use IMDb or TMDB ID if available when Top Poster API is selected
  let posterProxyId = `tvdb:${tvdbShow.id}`;
  if (config.posterRatingProvider === 'top' && (imdbId || tmdbId)) {
    posterProxyId = imdbId || `tmdb:${tmdbId}`;
  }
  const posterProxyUrl = Utils.buildPosterProxyUrl(host, 'series', posterProxyId, fallbackPosterUrl, language, config);
  const tvdbCredits = {
    cast: [...(characters || [])]
      .filter(c => c.peopleType === 'Actor')
      .sort((a, b) => {
        if (a.isFeatured !== b.isFeatured) {
          return a.isFeatured ? -1 : 1;
        }
        const sortA = (a.sort === null || a.sort === undefined) ? 999 : Number(a.sort);
        const sortB = (b.sort === null || b.sort === undefined) ? 999 : Number(b.sort);
        
        return sortA - sortB;
      })
      .map(c => ({
        name: c.personName,
        character: c.name,
        photo: c.image || c.personImgURL 
      }))
      .filter(c => c.name),
    crew: []
  };

  const directors = (characters || []).filter(c => c.peopleType === 'Director').map(c => c.personName).filter(Boolean);
  const writers = (characters || []).filter(c => c.peopleType === 'Writer').map(c => c.personName).filter(Boolean);

  
  const directorDetails = (characters || []).filter(c => c.peopleType === 'Director').map(d => ({
    name: d.personName,
    character: d.name,
    photo: d.image || d.personImgURL 
  })).filter(d => d.name);

  const writerDetails = (characters || []).filter(c => c.peopleType === 'Writer').map(w => ({
    name: w.personName,
    character: w.name,
    photo: w.image || w.personImgURL 
  })).filter(w => w.name);

  const directorLinks = directors.map(d => ({
    name: d,
    category: 'Directors',
    url: `stremio:///search?search=${d}`
  }));

  const writerLinks = writers.map(w => ({
    name: w,
    category: 'Writers',
    url: `stremio:///search?search=${w}`
  }));

  const { trailers, trailerStreams } = Utils.parseTvdbTrailers(tvdbShow.trailers, translatedName);





  let videos = [];
  let officialSeasons = (tvdbShow.seasons || [])
    .filter(s => s.type?.type === 'official')
    .sort((a, b) => a.number - b.number);
    
  let episodeList = tvdbEpisodes?.episodes || [];

  const normalizedData = normalizeTvdbSeasons(officialSeasons, episodeList);
  officialSeasons = normalizedData.seasons;
  episodeList = normalizedData.episodes;

  const seasonPosters = officialSeasons.map(s => s.image);

  if(includeVideos) {
    const seasonToKitsuIdMap = new Map();
    const absoluteToSeasonalMap = new Map();

    

    if (isAnime) {

      const seasonDetailPromises = officialSeasons.filter(s => s.number > 0).map(s => tvdb.getSeasonExtended(s.id, config));
      const detailedSeasons = (await Promise.all(seasonDetailPromises)).filter(Boolean);

      /*const kitsuMapPromises = detailedSeasons.map(async (season) => {
          const seasonalKitsuId = await idMapper.resolveKitsuIdFromTvdbSeason(tvdbId, season.number);
          if (seasonalKitsuId) {
              seasonToKitsuIdMap.set(season.number, seasonalKitsuId);
          }
      });
      await Promise.all(kitsuMapPromises);
      console.log(`[ID Builder] Built Season-to-Kitsu map for tvdb:${tvdbId}:`, seasonToKitsuIdMap);*/

      if (config.tvdbSeasonType === 'absolute') {
        let cumulativeEpisodes = 0;
        for (const season of detailedSeasons) {
          const episodeCount = season.episodes?.length || 0;
          const start = cumulativeEpisodes + 1;
          const end = cumulativeEpisodes + episodeCount;
          for (let i = start; i <= end; i++) {
            absoluteToSeasonalMap.set(i, {
              seasonNumber: season.number,
              episodeNumber: i - start + 1
            });
          }
          cumulativeEpisodes = end;
        }
      }
    }
    let imdbSeasonLayoutMap = new Map(); 
    if(config.tvdbSeasonType === 'absolute'){
      imdbSeasonLayoutMap = await tvdbAbsoluteToImdbHelper(tvdbShow, config);
    }
    
    
    videos = await Promise.all(
      episodeList.map(async (episode) => {
          // Use Top Poster API for episode thumbnails if enabled (Premium feature)
          let thumbnailUrl = null;
          let usingTopPoster = false;
          if (config.posterRatingProvider === 'top' && config.apiKeys?.topPoster && (tmdbId || imdbId)) {
            // Pass blur option to Top Poster API when blurThumbs is enabled
            const topPosterThumbnail = Utils.getTopPosterThumbnail(
              config,
              { tmdbId, imdbId },
              episode.seasonNumber,
              episode.number,
              config.apiKeys.topPoster,
              'w500', // Use w500 resolution
              episode.image ? (episode.image.startsWith('http') ? episode.image : `${TVDB_IMAGE_BASE}${episode.image}`) : null,
              { blur: config.blurThumbs || false }
            );
            if (topPosterThumbnail) {
              thumbnailUrl = topPosterThumbnail;
              usingTopPoster = true;
            }
          }
          
          // Fallback to TVDB thumbnail if Top Poster not available
          if (!thumbnailUrl) {
            // Check if episode is unaired (not aired or air_date in future)
            const isUnaired = !episode.aired || (episode.aired && new Date(episode.aired) > new Date());
            if (episode.image) {
              thumbnailUrl = episode.image.startsWith('http') ? episode.image : `${TVDB_IMAGE_BASE}${episode.image}`;
            } else if (isUnaired) {
              const season = officialSeasons.find(s => s.number === episode.seasonNumber);
              if (background) {
                thumbnailUrl = background;
              }
              else if (season?.image) {
                thumbnailUrl = season.image.startsWith('http') ? season.image : `${TVDB_IMAGE_BASE}${season.image}`;
              } else {
                thumbnailUrl = null;
              }
            } else {
              thumbnailUrl = background || `${host}/missing_thumbnail.png`;
            }
          }
          
          // Only apply local blur proxy when NOT using Top Poster API (Top Poster handles blur itself)
          const finalThumbnail = thumbnailUrl && config.blurThumbs && !usingTopPoster && thumbnailUrl !== `${host}/missing_thumbnail.png`
              ? `${host}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}`
              : thumbnailUrl;
          let episodeId;
          if (episode.seasonNumber === 0) {
            episodeId = `${imdbId || `tvdb:${tvdbId}`}:0:${episode.number}`;
          } 
          else if (config.providers?.anime_id_provider === 'kitsu' && isAnime) {
            if ((config.tvdbSeasonType === 'default' || config.tvdbSeasonType === 'official')){
              const anidbEpisodeInfo = await resolveAnidbEpisodeFromTvdbEpisode(tvdbId, episode.seasonNumber, episode.number);
              if (anidbEpisodeInfo) {
                // Get Kitsu ID from AniDB ID using the existing idMapper
                const kitsuMapping = await idMapper.getMappingByAnidbId(anidbEpisodeInfo.anidbId);
                if (kitsuMapping?.kitsu_id) {
                  episodeId = `kitsu:${kitsuMapping.kitsu_id}:${anidbEpisodeInfo.anidbEpisode}`;
                }
              }
            } else if (config.tvdbSeasonType === 'absolute') {
              const seasonalInfo = absoluteToSeasonalMap.get(episode.number);
              if (seasonalInfo) {
                const seasonalKitsuId = seasonToKitsuIdMap.get(seasonalInfo.seasonNumber);
                if (seasonalKitsuId) {
                  episodeId = `kitsu:${seasonalKitsuId}:${seasonalInfo.episodeNumber}`;
                }
              }
            }
          }
          else if(config.providers?.anime_id_provider === 'mal' && !config.mal?.useImdbIdForCatalogAndSearch) {
            if ((config.tvdbSeasonType === 'default' || config.tvdbSeasonType === 'official')){
              const anidbEpisodeInfo = await resolveAnidbEpisodeFromTvdbEpisode(tvdbId, episode.seasonNumber, episode.number);
              if (anidbEpisodeInfo) {
                // Get MAL ID from AniDB ID using the existing idMapper
                const malMapping = await idMapper.getMappingByAnidbId(anidbEpisodeInfo.anidbId);
                if (malMapping?.mal_id) {
                  episodeId = `mal:${malMapping.mal_id}:${anidbEpisodeInfo.anidbEpisode}`;
                }
              }
            } else if (config.tvdbSeasonType === 'absolute') {
              const seasonalInfo = absoluteToSeasonalMap.get(episode.number);
              if (seasonalInfo) {
                const seasonalKitsuId = seasonToKitsuIdMap.get(seasonalInfo.seasonNumber);
                if (seasonalKitsuId) {
                  const seasonalMalId = await idMapper.getMappingByKitsuId(seasonalKitsuId)?.mal;
                  episodeId = `mal:${seasonalMalId}:${seasonalInfo.episodeNumber}`;
                }
              }
            }
          }
          if (!episodeId) {
            if(config.tvdbSeasonType === 'absolute'){
              if (imdbSeasonLayoutMap.size > 0){
                const seasonalInfo = imdbSeasonLayoutMap.get(episode.number);
                if (seasonalInfo) {
                  if(episode.absoluteNumber !=0){
                    episodeId = `${imdbId || `tvdb:${tvdbId}`}:${seasonalInfo.seasonNumber}:${seasonalInfo.episodeNumber}`
                  }else{
                    episodeId = `${imdbId || `tvdb:${tvdbId}`}:${episode.seasonNumber}:${seasonalInfo.episodeNumber}`
                  }
                  
                }
              }
            }
            if (!episodeId){
              episodeId = `${imdbId || `tvdb:${tvdbId}`}:${episode.seasonNumber}:${episode.number}`;
            }
            
          }
            
          return {
              id: episodeId,
              title: episode.name || `Episode ${episode.number}`,
              season: episode.seasonNumber,
              episode: episode.number,
              thumbnail: finalThumbnail,
              overview: episode.overview,
              released: episode.aired ? createDateInTimezone(episode.aired, config.timezone || 'UTC') : null,
              available: episode.aired ? new Date(episode.aired) < new Date() : false,
              runtime: Utils.parseRunTime(episode.runtime),
          };
        })
    );
  }
  
  // Fallback to IMDB logo if logo is still missing (should work for both includeVideos=true and false)
  if(!logoUrl && imdbId){
    logoUrl =  imdb.getLogoFromImdb(imdbId);
  }
 
  // Build releaseInfo in format "first_year-last_year" or "first_year-" for ongoing series
  let tvdbReleaseInfo = year || "";
  if (tvdbShow.firstAired) {
    const firstYear = tvdbShow.firstAired.substring(0, 4);
    const isOngoing = tvdbShow.status?.name === 'Continuing' || !tvdbShow.lastAired;
    
    if (isOngoing) {
      tvdbReleaseInfo = `${firstYear}-`;
    } else {
      const lastYear = tvdbShow.lastAired.substring(0, 4);
      tvdbReleaseInfo = firstYear === lastYear ? firstYear : `${firstYear}-${lastYear}`;
    }
  }

  const certification = Utils.getTvdbCertification(tvdbShow.contentRatings, 'usa', 'tv');
  let links = Utils.buildLinks(imdbRating, imdbId, translatedName, 'series', tvdbShow.genres, tvdbCredits, language, castCount, userUUID, true, 'tvdb');
  if (!Array.isArray(links)) links = [];
  else links = [...links];
  if (castCount !== 0) {
    links.push(...directorLinks, ...writerLinks);
  }
  if(certification && config.displayAgeRating){
    const certificationLink = {
      name: certification,
      category: 'Genres',
      url: imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : `https://www.thetvdb.com/series/${tvdbShow.slug}`
    };
    links.unshift(certificationLink);
  }

  //console.log(tvdbShow.artworks?.find(a => a.type === 2)?.image);
  logger.debug(`[TvdbSeriesMeta] imdbId: ${imdbId}, stremioId: ${stremioId}`);
  const meta = {
    id: isAnime ? config.mal?.useImdbIdForCatalogAndSearch ? imdbId : stremioId : imdbId || stremioId,
    type: 'series',
    name: translatedName,
    imdb_id: imdbId,
    director: castCount !== 0 ? directors.join(', ') : '',
    writer: castCount !== 0 ? writers.join(', ') : '',
    slug: Utils.parseSlug('series', translatedName, imdbId, stremioId),
    genres: tvdbShow.genres?.map(g => g.name) || [],
    description: Utils.addMetaProviderAttribution(overview, 'TVDB', config),
    year: year,
    releaseInfo: tvdbReleaseInfo,
    released: tvdbShow.firstAired ? createDateInTimezone(tvdbShow.firstAired, config.timezone || 'UTC') : null,
    runtime: Utils.parseRunTime(tvdbShow.averageRuntime),
    status: tvdbShow.status?.name,
    country: tvdbShow.originalCountry,
    imdbRating,
    poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : poster,
    _rawPosterUrl: _rawPosterUrl,
    background: background, 
    landscapePoster: landscapePosterUrl,
    logo: logoUrl,
    videos: videos,
    trailers: trailers,
    trailerStreams: trailerStreams,
    links: links,
    behaviorHints: { defaultVideoId: null, hasScheduledVideos: true },
    app_extras: { cast: Utils.parseCast(tvdbCredits, castCount, 'tvdb'), directors: castCount !== 0 ? directorDetails : [], writers: castCount !== 0 ? writerDetails : [], seasonPosters: seasonPosters, certification: certification }
  };
  //console.log(Utils.parseCast(tmdbLikeCredits, castCount));
  return meta;
}

// Helper function to convert year to season number
function convertYearToSeason(episodes) {
  const seasonMap = new Map();
  const currentYear = new Date().getFullYear();
  
  // Group episodes by their "season" (which might be a year)
  const seasonGroups = new Map();
  episodes.forEach(episode => {
    const seasonKey = episode.season;
    if (!seasonGroups.has(seasonKey)) {
      seasonGroups.set(seasonKey, []);
    }
    seasonGroups.get(seasonKey).push(episode);
  });
  
  // Sort seasons chronologically by first episode air date
  const sortedSeasons = Array.from(seasonGroups.entries()).sort((a, b) => {
    const aFirstEpisode = a[1].sort((x, y) => new Date(x.airstamp) - new Date(y.airstamp))[0];
    const bFirstEpisode = b[1].sort((x, y) => new Date(x.airstamp) - new Date(y.airstamp))[0];
    return new Date(aFirstEpisode.airstamp) - new Date(bFirstEpisode.airstamp);
  });
  
  // Map years to sequential season numbers
  sortedSeasons.forEach(([originalSeason, episodes], index) => {
    const actualSeasonNumber = index + 1;
    seasonMap.set(originalSeason, actualSeasonNumber);
  });
  
  return seasonMap;
}

async function buildSeriesResponseFromTvmaze(stremioId, tvmazeShow, episodes, language, config, userUUID, enrichmentData = {}, isAnime = false, includeVideos = true) {
  const { allIds } = enrichmentData;
  const { name, premiered, image, summary, externals } = tvmazeShow;
  const imdbId = externals.imdb || allIds?.imdbId;
  const tmdbId = externals.themoviedb || allIds?.tmdbId;
  const tvdbId = externals.thetvdb || allIds?.tvdbId;
  const castCount = config.castCount;

  const tvmazePosterUrl = image?.original ? `${image.original}` : null;
  const tvmazeBackgroundUrl = image?.original ? `${image.original}` : null;
  const tvmazeLogoUrl = null;
  let poster, background, logoUrl, imdbRatingValue, landscapePosterUrl;
  
  const animeIdProviders = ['mal', 'anilist', 'kitsu', 'anidb'];
  // check if stremioId starts with one of the animeIdProviders
  if (isAnime && animeIdProviders.some(provider => stremioId.startsWith(provider))) {
    const artwork = await getAnimeArtwork(allIds, config, tvmazePosterUrl, tvmazeBackgroundUrl, 'series');
    poster = artwork.poster;
    background = artwork.background;
    logoUrl = artwork.logo;
    imdbRatingValue = artwork.imdbRatingValue;
    landscapePosterUrl = artwork.landscapePosterUrl;
  } else {
    [poster, background, logoUrl, imdbRatingValue, landscapePosterUrl] = await Promise.all([
      Utils.getSeriesPoster({ tmdbId: tmdbId, tvdbId: tvdbId, imdbId: imdbId, metaProvider: 'tvmaze', fallbackPosterUrl: tvmazePosterUrl }, config),
      Utils.getSeriesBackground({ tmdbId: tmdbId, tvdbId: tvdbId, imdbId: imdbId, metaProvider: 'tvmaze', fallbackBackgroundUrl: tvmazeBackgroundUrl }, config),
      Utils.getSeriesLogo({ tmdbId: tmdbId, tvdbId: tvdbId, imdbId: imdbId, metaProvider: 'tvmaze', fallbackLogoUrl: tvmazeLogoUrl }, config),
      getImdbRating(imdbId, 'series'),
      Utils.getSeriesBackground({ tmdbId: tmdbId, tvdbId: tvdbId, imdbId: imdbId, metaProvider: 'tvmaze', fallbackBackgroundUrl: landscapePosterUrl }, config, true)
  ]);
  }
  const imdbRating = imdbRatingValue || tvmazeShow.rating?.average?.toFixed(1) || "N/A";

  const tvmazeCredits = {
    cast: (tvmazeShow?._embedded?.cast || [])
      .map(c => ({
        name: c.person.name, character: c.character.name, photo: c.person.image?.medium
      }))
      .filter(c => c.name),
    crew: (tvmazeShow?._embedded?.cast || [])
      .filter(c => c.type === 'Creator')
      .map(c => ({
        name: c.person.name, job: 'Creator'
      }))
      .filter(c => c.name)
  };

  const producerLinks = (tvmazeShow?._embedded?.crew || []).filter(c => c.type === 'Executive Producer').map(d => ({
    name: d.person.name,
    category: 'Executive Producers',
    url: `stremio:///search?search=${d.person.name}`
  }));

  const writerLinks = (tvmazeShow?._embedded?.crew || []).filter(c => c.type === 'Creator').map(w => ({
    name: w.person.name,
    category: 'Writers',
    url: `stremio:///search?search=${w.person.name}`
  }));

  const producerDetails = (tvmazeShow?._embedded?.crew || []).filter(c => c.type === 'Executive Producer').map(d => ({
    name: d.person.name,
    character: d.person.name,
    photo: d.person.image?.medium
  }));

  const writerDetails = (tvmazeShow?._embedded?.crew || []).filter(c => c.type === 'Creator').map(w => ({
    name: w.person.name,
    character: w.person.name,
    photo: w.person.image?.medium
  })).filter(w => w.name);

  // Top Poster API only supports IMDb and TMDB IDs, not TVDB
  // Use IMDb or TMDB ID if available when Top Poster API is selected
  let posterProxyId = `tvdb:${tvdbId}`;
  if (config.posterRatingProvider === 'top' && (imdbId || tmdbId)) {
    posterProxyId = imdbId || `tmdb:${tmdbId}`;
  }
  const posterProxyUrl = Utils.buildPosterProxyUrl(host, 'series', posterProxyId, poster || '', language, config);
  const _rawPosterUrl = poster || `${host}/missing_poster.png`;
  let specialVideos = [];
  let videos = [];

  if(includeVideos){
    let specialCount = 1;
    (episodes || []).filter(episode => episode.type.toLowerCase().includes('special')).forEach(episode => {
      // Use Top Poster API for episode thumbnails if enabled (Premium feature)
      let thumbnailUrl = null;
      let usingTopPoster = false;
      if (config.posterRatingProvider === 'top' && config.apiKeys?.topPoster && (tmdbId || imdbId)) {
        // Pass blur option to Top Poster API when blurThumbs is enabled
        const topPosterThumbnail = Utils.getTopPosterThumbnail(
          config,
          { tmdbId, imdbId },
          0, // Special episodes are season 0
          specialCount,
          config.apiKeys.topPoster,
          'w500', // Use w500 resolution
          episode.image?.original || tvmazeShow.image?.original || null,
          { blur: config.blurThumbs || false }
        );
        if (topPosterThumbnail) {
          thumbnailUrl = topPosterThumbnail;
          usingTopPoster = true;
        }
      }
      
      // Fallback to TVMaze thumbnail if Top Poster not available
      if (!thumbnailUrl) {
        // Check if episode is unaired (airstamp in future)
        const isUnaired = new Date(episode.airstamp) > new Date();
        if (episode.image?.original) {
          thumbnailUrl = episode.image.original;
        } else if (isUnaired) {
          // For unaired episodes: try show image (poster), then background, then null
          if (background) {
            thumbnailUrl = background;
          }
          else if (tvmazeShow.image?.original) {
            thumbnailUrl = tvmazeShow.image.original;
          } else {
            thumbnailUrl = null;
          }
        } else {
          thumbnailUrl = background || `${host}/missing_thumbnail.png`;
        }
      }
      
      // Only apply local blur proxy when NOT using Top Poster API (Top Poster handles blur itself)
      let specialEpisode = {
        id: `${imdbId}:0:${specialCount}`,
        title: episode.name || `Episode ${specialCount}`,
        season: 0,
        episode: specialCount,
        thumbnail: thumbnailUrl && config.blurThumbs && !usingTopPoster && thumbnailUrl !== `${host}/missing_thumbnail.png`
          ? `${process.env.HOST_NAME}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}`
          : thumbnailUrl,
        overview: episode.summary ? episode.summary.replace(/<[^>]*>?/gm, '') : '',
        released: new Date(episode.airstamp),
        available: new Date(episode.airstamp) < new Date(),
        runtime: Utils.parseRunTime(episode.runtime),
      };
      specialCount++;
      specialVideos.push(specialEpisode);
    });

    // Convert years to season numbers if needed
    const seasonMap = convertYearToSeason(episodes || []);
    
    // Log season conversion for debugging
    if (seasonMap.size > 0) {
    logger.debug(`[TVmaze] Season conversion for ${stremioId}: ${JSON.stringify(Array.from(seasonMap.entries()))}`);
    }
    
    videos = (episodes || []).filter(episode => !episode.type.toLowerCase().includes('special')).map(episode => {
      const actualSeason = seasonMap.get(episode.season) || episode.season;
      
      // Use Top Poster API for episode thumbnails if enabled (Premium feature)
      let thumbnailUrl = null;
      let usingTopPoster = false;
      if (config.posterRatingProvider === 'top' && config.apiKeys?.topPoster && (tmdbId || imdbId)) {
        // Pass blur option to Top Poster API when blurThumbs is enabled
        const topPosterThumbnail = Utils.getTopPosterThumbnail(
          config,
          { tmdbId, imdbId },
          actualSeason,
          episode.number,
          config.apiKeys.topPoster,
          'w500', // Use w500 resolution
          episode.image?.original || tvmazeShow.image?.original || null,
          { blur: config.blurThumbs || false }
        );
        if (topPosterThumbnail) {
          thumbnailUrl = topPosterThumbnail;
          usingTopPoster = true;
        }
      }
      
      // Fallback to TVMaze thumbnail if Top Poster not available
      if (!thumbnailUrl) {
        // Check if episode is unaired (airstamp in future)
        const isUnaired = new Date(episode.airstamp) > new Date();
        if (episode.image?.original) {
          thumbnailUrl = episode.image.original;
        } else if (isUnaired) {
          // For unaired episodes: try show image (poster), then background, then null
          if (tvmazeShow.image?.original) {
            thumbnailUrl = tvmazeShow.image.original;
          } else if (background) {
            thumbnailUrl = background;
          } else {
            thumbnailUrl = null;
          }
        } else {
          thumbnailUrl = background || `${host}/missing_thumbnail.png`;
        }
      }
      
      // Only apply local blur proxy when NOT using Top Poster API (Top Poster handles blur itself)
      return {
        id: `${imdbId}:${actualSeason}:${episode.number}`,
        title: episode.name || `Episode ${episode.number}`,
        season: actualSeason,
        episode: episode.number,
        thumbnail: thumbnailUrl && config.blurThumbs && !usingTopPoster && thumbnailUrl !== `${host}/missing_thumbnail.png`
          ? `${process.env.HOST_NAME}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}`
          : thumbnailUrl,
        overview: episode.summary ? episode.summary.replace(/<[^>]*>?/gm, '') : '',
        released: new Date(episode.airstamp),
        available: new Date(episode.airstamp) < new Date(),
        runtime: Utils.parseRunTime(episode.runtime),
      };
    });
  }

  let certification = null;
  if(tmdbId){
    const seriesData = await moviedb.tvInfo({ id: tmdbId, language, append_to_response: "content_ratings" }, config);
    if (seriesData) {
    certification = Utils.getTmdbTvCertificationForCountry(seriesData.content_ratings);
    }
  }
  videos = [... specialVideos, ... videos];
  if(!logoUrl && imdbId){
    logoUrl =  imdb.getLogoFromImdb(imdbId);
  }

  let links = [...Utils.buildLinks(imdbRating, imdbId, name, 'series', tvmazeShow.genres.map(g => ({ name: g })), tvmazeCredits, language, castCount, userUUID, false, 'tvmaze')];
  if (castCount !== 0) {
    links.push(...producerLinks, ...writerLinks);
  }
  if(certification && config.displayAgeRating){
    const certificationLink = {
      name: certification,
      category: 'Genres',
      url: imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : `https://www.tvmaze.com/shows/${tvmazeShow.id}`
    };
    links.unshift(certificationLink);
  }

  const meta = {
    id: isAnime ? stremioId : imdbId || stremioId,
    type: 'series', 
    name: name, 
    imdb_id: imdbId,
    slug: Utils.parseSlug('series', name, stremioId),
    genres: tvmazeShow.genres || [],
    description: Utils.addMetaProviderAttribution(summary ? summary.replace(/<[^>]*>?/gm, '') : '', 'TVmaze', config),
    year: premiered ? premiered.substring(0, 4) : "",
    releaseInfo: Utils.parseYear(tvmazeShow.status, premiered, tvmazeShow.ended),
    released: premiered ? createDateInTimezone(premiered, config.timezone || 'UTC') : null,
    runtime: tvmazeShow.runtime ? Utils.parseRunTime(tvmazeShow.runtime) : Utils.parseRunTime(tvmazeShow.averageRuntime),
    status: tvmazeShow.status,
    country: tvmazeShow.network?.country?.name || null,
    imdbRating,
    poster: Utils.isPosterRatingEnabled(config) ? posterProxyUrl : poster, 
    _rawPosterUrl: _rawPosterUrl,
    background: background,
    landscapePoster: landscapePosterUrl,
    logo: processLogo(logoUrl), 
    videos,
    links: links,
    behaviorHints: { defaultVideoId: null, hasScheduledVideos: true },
    app_extras: { cast: Utils.parseCast(tvmazeCredits, castCount, 'tvmaze'), producers: producerDetails, writers: writerDetails, certification: certification }
  };

  return meta;
}


async function buildAnimeResponse(stremioId, malData, language, characterData, episodeData, config, userUUID, enrichmentData = {}) {
  try {
    const { mapping, bestBackgroundUrl, bestLandscapePosterUrl } = enrichmentData;
    const stremioType = malData.type.toLowerCase() === 'movie' ? 'movie' : 'series';
    const imdbId = mapping?.imdbId;
    const kitsuId = mapping?.kitsuId;
    const imdbRating = typeof malData.score === 'number' ? malData.score.toFixed(1) : "N/A";
    const castCount = config.castCount;  
    let videos = [];
    const seriesId = `mal:${malData.mal_id}`;
    
    let idProvider = config.providers?.anime_id_provider || 'kitsu';
    if (idProvider === 'retain') {
      if (stremioId.startsWith('mal:')) idProvider = 'mal';
      else if (stremioId.startsWith('kitsu:')) idProvider = 'kitsu';
      else if (stremioId.startsWith('tt')) idProvider = 'imdb';
      else idProvider = 'kitsu';
    }

    if (idProvider === 'kitsu' && kitsuId) {
      primaryId = `kitsu:${kitsuId}`;
    }
    const posterUrl = malData.images?.jpg?.large_image_url;

    // Use AniList poster if available and configured
    let finalPosterUrl = enrichmentData.bestPosterUrl || posterUrl; 
    const _rawPosterUrl = finalPosterUrl;
    // Check if poster rating is enabled (RPDB or Top Poster API)
    if (Utils.isPosterRatingEnabled(config) && mapping && stremioType !== 'movie') {
      const tvdbId = mapping.tvdbId;
      const tmdbId = mapping.tmdbId;
      const imdbId = mapping.imdbId;
      let proxyId = null;
      let proxyType = stremioType;

      if (tvdbId) {
        proxyId = `tvdb:${tvdbId}`;
      } else if (tmdbId || imdbId) {
        proxyId = tmdbId ? `tmdb:${tmdbId}` : `imdb:${imdbId}`; 
      }

      if (proxyId) {
        finalPosterUrl = Utils.buildPosterProxyUrl(host, proxyType, proxyId, posterUrl, language, config);
      logger.debug(`[buildAnimeResponse] Constructed Poster Rating Proxy URL: ${finalPosterUrl}`);
      }
    }
    
    
    // Process episodes while API calls are running
    if (stremioType === 'series' && malData.status !== 'Not yet aired' && episodeData && episodeData.length > 0) {      // Filter episodes once
      

      // Pre-fetch franchise info once to avoid repeated API calls for each episode
      let franchiseInfo = null;
      let tmdbThumbnailMap = new Map(); // Map of "season:episode" -> thumbnail URL
      let tmdbSeasonPosterMap = new Map(); // Map of season -> season poster url
      let tmdbAirDateMap = new Map(); // Map of "season:episode" -> air_date
      let tmdbEpisodeMap = new Map(); // Map of kitsuEpisodeNumber -> tmdbEpisode
      let tmdbEpisodeTitleMap = new Map(); // Map of "season:episode" -> episode title
      let tmdbEpisodeOverviewMap = new Map(); // Map of "season:episode" -> episode overview
      const mapping = idMapper.getMappingByKitsuId(kitsuId);
      
      if (mapping?.themoviedb_id && kitsuId) {
        try {
          franchiseInfo = await idMapper.getFranchiseInfoFromTmdbId(mapping.themoviedb_id);
          
          // Resolve all TMDB episodes and group by season for bulk fetching
          const seasonSet = new Set();
          
          for (const ep of episodeData) {
            try {
              const tmdbEpisode = await idMapper.resolveTmdbEpisodeFromKitsu(kitsuId, ep.mal_id, config);
              if (tmdbEpisode && tmdbEpisode.tmdbId) {
                tmdbEpisodeMap.set(ep.mal_id, tmdbEpisode);
                seasonSet.add(tmdbEpisode.seasonNumber);
              }
            } catch (error) {
              logger.debug(`[buildKitsuAnimeResponse] Failed to resolve TMDB episode for Kitsu episode ${ep.mal_id}: ${error.message}`);
            }
          }
          
          // Fetch TMDB season details in bulk if we have resolved episodes
          if (tmdbEpisodeMap.size > 0 && seasonSet.size > 0) {
            try {
              const tmdbId = mapping.themoviedb_id;
              const language = config.language || 'en-US';
              const seasonsArray = Array.from(seasonSet).sort((a, b) => a - b);

              // Create season objects for genSeasonsString and chunk the requests
              const seasonObjects = seasonsArray.map(s => ({ season_number: s }));
              const seasonChunks = Utils.genSeasonsString(seasonObjects);

              const seasonPromises = seasonChunks.map(chunk => moviedb.tvInfo({ 
                id: tmdbId, 
                language, 
                append_to_response: chunk
              }, config));

              const seasonResponses = await Promise.all(seasonPromises);

              const combinedResponse = seasonResponses.reduce((acc, res) => ({ ...acc, ...res }), {});
              
              seasonsArray.forEach(seasonNum => {
                const seasonKey = `season/${seasonNum}`;
                const seasonData = combinedResponse[seasonKey];
                if (seasonData && seasonData.episodes) {
                  seasonData.episodes.forEach(tmdbEp => {
                    const key = `${seasonNum}:${tmdbEp.episode_number}`;
                    if (tmdbEp.still_path) {
                      tmdbThumbnailMap.set(key, `https://image.tmdb.org/t/p/w500${tmdbEp.still_path}`);
                    }
                    if (tmdbEp.air_date) {
                      tmdbAirDateMap.set(key, tmdbEp.air_date);
                    }
                    if (tmdbEp.name) {
                      tmdbEpisodeTitleMap.set(key, tmdbEp.name);
                    }
                    if (tmdbEp.overview) {
                      tmdbEpisodeOverviewMap.set(key, tmdbEp.overview);
                    }
                  });
                  // store season poster for fallback on unaired episodes
                  if (seasonData.poster_path) {
                    tmdbSeasonPosterMap.set(seasonNum, `https://image.tmdb.org/t/p/w500${seasonData.poster_path}`);
                  }
                }
              });
            } catch (error) {
              logger.debug(`[buildKitsuAnimeResponse] Failed to fetch TMDB season thumbnails: ${error.message}`);
            }
          }
        } catch (error) {
          logger.debug(`[buildKitsuAnimeResponse] Failed to fetch franchise info: ${error.message}`);
        }
      }
      
      // Process episodes with enhancement data        
      videos = (episodeData || []).map(ep => {
        let episodeId = `${seriesId}:${ep.mal_id}`;
        if (idProvider === 'kitsu' && kitsuId) {
          episodeId = `kitsu:${kitsuId}:${ep.mal_id}`;
        } else if (idProvider === 'imdb' && (imdbId || kitsuId)) {
          episodeId = `kitsu:${kitsuId}:${ep.mal_id}`;
        } 
        
        // Try to enhance with Kitsu data
        let thumbnailUrl = null;
        let usingTopPoster = false;
        let episodeTitle = ep.title;
        let episodeSynopsis = ep.synopsis;
        // Try to get thumbnail from TMDB or Top Poster
        const tmdbEpisode = tmdbEpisodeMap.get(ep.mal_id);
        // Pre-calc airDate so we can decide if episode is upcoming
        let airDate = ep.airdate;
        
        // First try Top Poster if enabled
        if (config.posterRatingProvider === 'top' && config.apiKeys?.topPoster && tmdbEpisode) {
          try {
            // Pass blur option to Top Poster API when blurThumbs is enabled
            const topPosterThumbnail = Utils.getTopPosterThumbnail(
              config,
              { tmdbId: tmdbEpisode.tmdbId, imdbId },
              tmdbEpisode.seasonNumber,
              tmdbEpisode.episodeNumber,
              config.apiKeys.topPoster,
              'w500',
              thumbnailUrl,
              { blur: config.blurThumbs || false }
            );
            if (topPosterThumbnail) {
              thumbnailUrl = topPosterThumbnail;
              usingTopPoster = true;
            }
          } catch (error) {
            logger.debug(`[buildKitsuAnimeResponse] Failed to get Top Poster thumbnail: ${error.message}`);
          }
        }
        
        // Fallback to TMDB thumbnail if Top Poster not available or not enabled
        if (!thumbnailUrl && tmdbEpisode) {
          const key = `${tmdbEpisode.seasonNumber}:${tmdbEpisode.episodeNumber}`;
          const tmdbThumbnail = tmdbThumbnailMap.get(key);
          if (tmdbThumbnail) {
            thumbnailUrl = tmdbThumbnail;
          }
        }
        // If still no thumbnail: treat unaired (upcoming) episodes specially and fallback to season poster -> background -> null
        if (!thumbnailUrl) {
          const isUnaired = !airDate || createDateInTimezone(airDate, config.timezone || 'UTC') > new Date();
          if (isUnaired) {
            if (bestBackgroundUrl) {
              logger.debug(`[buildAnimeResponse] Using series background as fallback thumbnail for upcoming Kitsu ${kitsuId} Ep ${ep.mal_id}`);
              thumbnailUrl = bestBackgroundUrl;
            }
            else if (tmdbEpisode && !tmdbEpisode.isFranchiseFallback && tmdbSeasonPosterMap.size > 0) {
              const seasonPoster = tmdbSeasonPosterMap.get(tmdbEpisode.seasonNumber);
              if (seasonPoster) {
                thumbnailUrl = seasonPoster;
              }
            }
            else {
              thumbnailUrl = null;
            }
          } else {
            thumbnailUrl = background || `${host}/missing_thumbnail.png`;
          }
        }
        
        let key = tmdbEpisode ? `${tmdbEpisode.seasonNumber}:${tmdbEpisode.episodeNumber}` : null;
        if (!airDate && tmdbEpisode && key && !tmdbEpisode.isFranchiseFallback) {
          airDate = tmdbAirDateMap.get(key);
        }
        else if (!airDate && tmdbEpisode && key && tmdbEpisode.isFranchiseFallback) {
          logger.debug(`[buildKitsuAnimeResponse] Skipping TMDB air date for Kitsu ${kitsuId} Ep ${ep.mal_id} because mapping is franchise fallback`);
        }
        if(!episodeTitle && tmdbEpisode && key && !tmdbEpisode.isFranchiseFallback) {
          episodeTitle = tmdbEpisodeTitleMap.get(key);
        } else if (!episodeTitle && tmdbEpisode && key && tmdbEpisode.isFranchiseFallback) {
          logger.debug(`[buildKitsuAnimeResponse] Skipping TMDB title fallback for Kitsu ${kitsuId} Ep ${ep.mal_id} because mapping is franchise fallback`);
        }
        episodeTitle = episodeTitle || `Episode ${ep.mal_id}`;

        if(!episodeSynopsis && tmdbEpisode && key && !tmdbEpisode.isFranchiseFallback) {
          episodeSynopsis = tmdbEpisodeOverviewMap.get(key);
        } else if (!episodeSynopsis && tmdbEpisode && key && tmdbEpisode.isFranchiseFallback) {
          logger.debug(`[buildKitsuAnimeResponse] Skipping TMDB overview fallback for Kitsu ${kitsuId} Ep ${ep.mal_id} because mapping is franchise fallback`);
        }
        episodeSynopsis = episodeSynopsis || ep.synopsis || '';
        // Build final thumbnail; keep null for upcoming episodes if no background/season poster available
        // Only apply local blur proxy when NOT using Top Poster API (Top Poster handles blur itself)
        const finalThumbnail = thumbnailUrl && config.blurThumbs && !usingTopPoster && thumbnailUrl !== `${host}/missing_thumbnail.png`
          ? `${host}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}`
          : thumbnailUrl;

        if (config.mal?.allowEpisodeMarking) {
          if (ep.filler) {
            episodeSynopsis = `[Filler] ${episodeSynopsis}`;
          }
          if (ep.recap) {
            episodeSynopsis = `[Recap] ${episodeSynopsis}`;
          }
        }
        
        return {
          id: episodeId,
          title: episodeTitle,
          season: 1,
          episode: ep.mal_id,
          released: (ep.aired) ? new Date(ep.aired.substring(0, 10)) : null,
          thumbnail: finalThumbnail || ((airDate && (new Date(airDate) < new Date())) ? `${host}/missing_thumbnail.png` : null),
          available: (ep.aired) ? new Date(ep.aired) < new Date() : false,
          overview: episodeSynopsis,
          isFiller: ep.filler,
          isRecap: ep.recap,
          runtime: Utils.parseRunTime(malData.duration)
        };
      });
      
      
      // Special processing for IMDB provider with season info
      if (idProvider === 'imdb') {
        try {
          const enrichedVideos = await idMapper.enrichMalEpisodes(videos, kitsuId, false);
          if (enrichedVideos && Array.isArray(enrichedVideos) && enrichedVideos.length > 0) {
            videos = enrichedVideos;
            videos.forEach(ep => {
              ep.runtime = Utils.parseRunTime(malData.duration);
            });
            logger.debug(`[getMeta] Successfully enriched ${enrichedVideos.length} episodes with IMDB data`);
          } else if (enrichedVideos === null) {
            logger.debug(`[getMeta] No IMDB enrichment available for kitsuId ${kitsuId}, using original videos`);
          } else {
            logger.warn(`[getMeta] enrichMalEpisodes returned invalid data: ${JSON.stringify(enrichedVideos)}`);
          }
        } catch (error) {
          logger.error(`[getMeta] Error enriching MAL episodes: ${error.message}`);
          // Keep original videos if enrichment fails
        }
      }  
    }
    logger.debug(`[getMeta] Videos length: ${videos.length}`);

    videos = videos.filter(ep => {
      if (config.mal?.skipFiller && ep.isFiller) return false;
      if (config.mal?.skipRecap && ep.isRecap) return false;
      return true;
    });

    // Optimize cast processing with pre-computed replacements
    const cast = (characterData || [])
        .map(charEntry => {
          const voiceActor = charEntry.voice_actors.find(va => va.language === 'Japanese');
          if (!voiceActor) return null;
          return {
            name: voiceActor.person.name.replace(",", ""),
            photo: voiceActor.person.images.jpg.image_url,
            character: charEntry.character.name.replace(",", ""),
          };
        })
      .filter(Boolean);

    const tmdbLikeCredits = {
      cast,
      crew: []
    };

    // Optimize trailer processing
    const trailerStreams = [];
    const trailers = [];
    if (malData.trailer?.youtube_id) {
      const trailerTitle = malData.title_english || malData.title;
      trailerStreams.push({
        ytId: malData.trailer.youtube_id,
        title: trailerTitle
      });
      trailers.push({
        source: malData.trailer.youtube_id,
        type: "Trailer",
        name: trailerTitle
      });
    }

    // Build links efficiently
    const links = [];
    if (imdbId) {
      links.push(Utils.parseImdbLink(imdbRating, imdbId));
      links.push(Utils.parseShareLink(malData.title, imdbId, stremioType));
    }
    links.push(...Utils.parseAnimeGenreLink(malData.genres?.map(g => g.name), stremioType, userUUID));
    links.push(...Utils.parseAnimeCreditsLink(characterData, userUUID, castCount));
    links.push(...Utils.parseAnimeRelationsLink(malData.relations, stremioType, userUUID));

    let watchProviders = malData.streaming;
 
    // Build releaseInfo in format "first_year-last_year" or "first_year-" for ongoing series
    let malReleaseInfo = malData.year || (malData.aired?.from ? malData.aired.from.substring(0, 4) : "");
    if (stremioType === 'series' && malData.aired) {
      const firstYear = malData.aired.from ? malData.aired.from.substring(0, 4) : "";
      if (firstYear) {
        const isOngoing = malData.status === 'Currently Airing' || !malData.aired.to;
        
        if (isOngoing) {
          malReleaseInfo = `${firstYear}-`;
        } else if (malData.aired.to) {
          const lastYear = malData.aired.to.substring(0, 4);
          malReleaseInfo = firstYear === lastYear ? firstYear : `${firstYear}-${lastYear}`;
        }
      }
    }
    if(malData.rating && config.displayAgeRating){
      const ageRatingLink = {
        name: malData.rating,
        category: 'Genres',
        url: imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : `https://myanimelist.net/anime/${malData.mal_id}`
      };
      links.unshift(ageRatingLink);
    }

    const meta = {
      id: stremioId,
      type: stremioType,
      description: Utils.addMetaProviderAttribution(malData.synopsis, 'MAL', config),
      name: malData.title_english || malData.title,
      imdb_id: imdbId,
      mal_id: malData.mal_id,
      slug: Utils.parseSlug('series', malData.title_english || malData.title, imdbId, malData.mal_id),
      genres: malData.genres?.map(g => g.name) || [],
      year: malData.year || malData.aired?.from?.substring(0, 4),
      released: (malData.aired?.from || malData.start_date) ? createDateInTimezone(malData.aired?.from || malData.start_date, config.timezone || 'UTC') : null,
      runtime: Utils.parseRunTime(malData.duration),
      status: malData.status,
      imdbRating,
      poster: finalPosterUrl,
      _rawPosterUrl: _rawPosterUrl,
      background: bestBackgroundUrl,
      landscapePoster: bestLandscapePosterUrl,
      logo: enrichmentData.bestLogoUrl,
      links: links.filter(Boolean),
      trailers: trailers,
      trailerStreams: trailerStreams,
      releaseInfo: malReleaseInfo,
      director: [],
      writers: [],
      behaviorHints: {
        defaultVideoId: (stremioType === 'movie' || (malData.type.toLowerCase() === 'tv special' && (episodeData === null || episodeData?.length == 0))) ? ((kitsuId && idProvider === 'kitsu') ? `kitsu:${kitsuId}` : (imdbId && idProvider === 'imdb') ? imdbId : stremioId) : null,
        hasScheduledVideos: stremioType === 'series',
      },
      videos: videos,
      app_extras: {
        cast: Utils.parseCast(tmdbLikeCredits, castCount, 'mal'),
        director: [],
        writers: [],
        watchProviders: watchProviders
      }
    };

    return meta;

  } catch (err) {
    logger.error(`Error processing MAL ID ${malData?.mal_id}: ${err?.message || err}`);
    return null;
  }
}


async function buildKitsuAnimeResponse(stremioId, kitsuData, genres, includeObject, episodeData, config, userUUID, enrichmentData = {}) {
  try {
    const { mapping, bestBackgroundUrl, bestPosterUrl, bestLogoUrl, bestLandscapePosterUrl } = enrichmentData

    const stremioType =
      kitsuData.attributes.subtype?.toLowerCase() === 'movie' ? 'movie' : 'series'

    let relationships = includeObject?.filter(item => item.type === 'mediaRelationships' && ['prequel', 'sequel'].some(role => item.attributes?.role.toLowerCase().includes(role)) && item.relationships?.destination?.data?.type === 'anime') || [];

    const imdbId = mapping?.imdbId
    const malId = mapping?.malId
    const seriesId = `kitsu:${kitsuData.id}`
    
    let idProvider = config.providers?.anime_id_provider || 'kitsu'
    if (idProvider === 'retain') {
      if (stremioId.startsWith('mal:')) idProvider = 'mal';
      else if (stremioId.startsWith('kitsu:')) idProvider = 'kitsu';
      else if (stremioId.startsWith('tt')) idProvider = 'imdb';
      else idProvider = 'kitsu';
    }
    const _rawPosterUrl = bestPosterUrl || `${config.host}/missing_poster.png`;

    let kitsuReleaseInfo = kitsuData.attributes.startDate ? kitsuData.attributes.startDate.substring(0, 4) : null;
    if (stremioType === 'series' && kitsuData.attributes.startDate) {
      const firstYear = kitsuData.attributes.startDate ? kitsuData.attributes.startDate.substring(0, 4) : "";
      if (firstYear) {
        const isOngoing = kitsuData.attributes.status === 'current' || !kitsuData.attributes.endDate;
        
        if (isOngoing) {
          kitsuReleaseInfo = `${firstYear}-`;
        } else if (kitsuData.attributes.endDate) {
          const lastYear = kitsuData.attributes.endDate.substring(0, 4);
          kitsuReleaseInfo = firstYear === lastYear ? firstYear : `${firstYear}-${lastYear}`;
        }
      }
    }
    const imdbRating = imdbId ? await getImdbRating(imdbId, stremioType) || 'N/A' : 'N/A';
    const kitsuTitle = Utils.getKitsuLocalizedTitle(kitsuData.attributes.titles, config.language) || kitsuData.attributes.canonicalTitle;
    const links = [];
    if (imdbId) {
      links.push(Utils.parseImdbLink(imdbRating, imdbId));
      links.push(Utils.parseShareLink(kitsuTitle, imdbId, stremioType));
    }

    links.push(...Utils.parseAnimeGenreLink(genres, stremioType, userUUID));
    const relatedLinks = relationships.map(relationship => {
      const relationshipData = includeObject?.find(item => item.id === relationship.relationships?.destination?.data?.id);
      if (!relationshipData) {
        return null;
      }
      return {
        name: Utils.getKitsuLocalizedTitle(relationshipData?.attributes?.titles, config.language) || relationshipData?.attributes?.canonicalTitle,
        category: relationship.attributes?.role,
        url: `stremio:///detail/series/kitsu:${relationshipData?.id}`
      }
    });
    links.push(...relatedLinks.filter(Boolean));
    if(kitsuData.attributes.ageRating && config.displayAgeRating){
      const ageRatingLink = {
        name: kitsuData.attributes.ageRating,
        category: 'Genres',
        url: imdbId ? `https://www.imdb.com/title/${imdbId}/parentalguide/` : `https://kitsu.app/anime/${kitsuData.attributes.slug}`
      };
      links.unshift(ageRatingLink);
    }

    // 🔹 base meta object
    const meta = {
      id: stremioId,
      type: stremioType,
      imdb_id: imdbId,
      name: kitsuTitle,
      description: Utils.addMetaProviderAttribution(
        kitsuData.attributes.synopsis || kitsuData.attributes.description || '',
        'KITSU',
        config
      ),
      genres,
      year: kitsuData.attributes.startDate
        ? kitsuData.attributes.startDate.substring(0, 4) : null,
      released: kitsuData.attributes.startDate
        ? createDateInTimezone(kitsuData.attributes.startDate, config.timezone || 'UTC')
        : null,
      releaseInfo: kitsuReleaseInfo,
      runtime: Utils.parseRunTime(kitsuData.attributes.episodeLength),
      status: kitsuData.attributes.status || 'unknown',
      imdbRating: imdbRating,
      poster:
        bestPosterUrl ||
        kitsuData.attributes.posterImage?.original ||
        `${config.host}/missing_poster.png`,
      _rawPosterUrl: _rawPosterUrl,
      background:
        bestBackgroundUrl ||
        kitsuData.attributes.coverImage?.original,
      landscapePoster: bestLandscapePosterUrl,
      logo: bestLogoUrl,
      links: links,
      trailers: [],
      trailerStreams: [],
      director: [],
      writers: [],
      behaviorHints: {
        defaultVideoId: stremioType === 'movie' ? stremioId : null,
        hasScheduledVideos: stremioType === 'series'
      },
      videos: [],
      app_extras: {
        cast: [],
        director: [],
        writers: [],
        watchProviders: [],
        certification: kitsuData.attributes.ageRating
      }
    }

    // 🔹 episodes for series
    if (stremioType === 'series' && Array.isArray(episodeData) && episodeData.length > 0) {
      // Pre-fetch franchise info once to avoid repeated API calls for each episode
      let franchiseInfo = null;
      let tmdbThumbnailMap = new Map(); // Map of "season:episode" -> thumbnail URL
      let tmdbSeasonPosterMap = new Map(); // Map of season -> season poster url
      let tmdbAirDateMap = new Map(); // Map of "season:episode" -> air_date
      let tmdbEpisodeMap = new Map(); // Map of kitsuEpisodeNumber -> tmdbEpisode
      let tmdbEpisodeTitleMap = new Map(); // Map of "season:episode" -> episode title
      let tmdbEpisodeOverviewMap = new Map(); // Map of "season:episode" -> episode overview
      const mapping = idMapper.getMappingByKitsuId(kitsuData.id);
      
      if (mapping?.themoviedb_id) {
        try {
          franchiseInfo = await idMapper.getFranchiseInfoFromTmdbId(mapping.themoviedb_id);
          
          // Resolve all TMDB episodes and group by season for bulk fetching
          const seasonSet = new Set();
          
          for (const item of episodeData) {
            const ep = item.attributes;
            try {
              const tmdbEpisode = await idMapper.resolveTmdbEpisodeFromKitsu(kitsuData.id, ep.number, config);
              if (tmdbEpisode && tmdbEpisode.tmdbId) {
                tmdbEpisodeMap.set(ep.number, tmdbEpisode);
                seasonSet.add(tmdbEpisode.seasonNumber);
              }
            } catch (error) {
              logger.debug(`[buildKitsuAnimeResponse] Failed to resolve TMDB episode for Kitsu episode ${ep.number}: ${error.message}`);
            }
          }
          
          // Fetch TMDB season details in bulk if we have resolved episodes
          if (tmdbEpisodeMap.size > 0 && seasonSet.size > 0) {
            try {
              const tmdbId = mapping.themoviedb_id;
              const language = config.language || 'en-US';
              const seasonsArray = Array.from(seasonSet).sort((a, b) => a - b);

              // Create season objects for genSeasonsString and chunk the requests
              const seasonObjects = seasonsArray.map(s => ({ season_number: s }));
              const seasonChunks = Utils.genSeasonsString(seasonObjects);

              const seasonPromises = seasonChunks.map(chunk => moviedb.tvInfo({ 
                id: tmdbId, 
                language, 
                append_to_response: chunk
              }, config));

              const seasonResponses = await Promise.all(seasonPromises);

              const combinedResponse = seasonResponses.reduce((acc, res) => ({ ...acc, ...res }), {});
              
              seasonsArray.forEach(seasonNum => {
                const seasonKey = `season/${seasonNum}`;
                const seasonData = combinedResponse[seasonKey];
                if (seasonData && seasonData.episodes) {
                  seasonData.episodes.forEach(tmdbEp => {
                    const key = `${seasonNum}:${tmdbEp.episode_number}`;
                    if (tmdbEp.still_path) {
                      tmdbThumbnailMap.set(key, `https://image.tmdb.org/t/p/w500${tmdbEp.still_path}`);
                    }
                    if (tmdbEp.air_date) {
                      tmdbAirDateMap.set(key, tmdbEp.air_date);
                    }
                    if (tmdbEp.name) {
                      tmdbEpisodeTitleMap.set(key, tmdbEp.name);
                    }
                    if (tmdbEp.overview) {
                      tmdbEpisodeOverviewMap.set(key, tmdbEp.overview);
                    }
                  });
                  // store season poster for fallback on unaired episodes
                  if (seasonData.poster_path) {
                    tmdbSeasonPosterMap.set(seasonNum, `https://image.tmdb.org/t/p/w500${seasonData.poster_path}`);
                  }
                }
              });
            } catch (error) {
              logger.debug(`[buildKitsuAnimeResponse] Failed to fetch TMDB season thumbnails: ${error.message}`);
            }
          }
        } catch (error) {
          logger.debug(`[buildKitsuAnimeResponse] Failed to fetch franchise info: ${error.message}`);
        }
      }
      
      meta.videos = await Promise.all(episodeData.map(async (item) => {
        const ep = item.attributes;
        let episodeId = `${seriesId}:${ep.number}`
        if (idProvider === 'mal' && malId) {
          episodeId = `mal:${malId}:${ep.number}`
        }
        
        // Try to get thumbnail from TMDB or Top Poster
        let thumbnailUrl = ep.thumbnail?.original || null;
        let usingTopPoster = false;
        const tmdbEpisode = tmdbEpisodeMap.get(ep.number);
        // Pre-calc airDate so we can decide if episode is upcoming
        let airDate = ep.airdate;
        
        // First try Top Poster if enabled
        if (config.posterRatingProvider === 'top' && config.apiKeys?.topPoster && tmdbEpisode) {
          try {
            // Pass blur option to Top Poster API when blurThumbs is enabled
            const topPosterThumbnail = Utils.getTopPosterThumbnail(
              config,
              { tmdbId: tmdbEpisode.tmdbId, imdbId },
              tmdbEpisode.seasonNumber,
              tmdbEpisode.episodeNumber,
              config.apiKeys.topPoster,
              'w500',
              thumbnailUrl,
              { blur: config.blurThumbs || false }
            );
            if (topPosterThumbnail) {
              thumbnailUrl = topPosterThumbnail;
              usingTopPoster = true;
            }
          } catch (error) {
            logger.debug(`[buildKitsuAnimeResponse] Failed to get Top Poster thumbnail: ${error.message}`);
          }
        }
        
        // Fallback to TMDB thumbnail if Top Poster not available or not enabled
        if (!thumbnailUrl && tmdbEpisode) {
          const key = `${tmdbEpisode.seasonNumber}:${tmdbEpisode.episodeNumber}`;
          const tmdbThumbnail = tmdbThumbnailMap.get(key);
          if (tmdbThumbnail) {
            thumbnailUrl = tmdbThumbnail;
          }
        }
        // If still no thumbnail: treat unaired (upcoming) episodes specially and fallback to season poster -> background -> null
        if (!thumbnailUrl) {
          const isUnaired = !airDate || createDateInTimezone(airDate, config.timezone || 'UTC') > new Date();
          if (isUnaired) {
            if (bestBackgroundUrl) {
              logger.debug(`[buildKitsuAnimeResponse] Using series background as fallback thumbnail for upcoming Kitsu ${kitsuData.id} Ep ${ep.number}`);
              thumbnailUrl = bestBackgroundUrl;
            }
            else if (tmdbEpisode && !tmdbEpisode.isFranchiseFallback && tmdbSeasonPosterMap.size > 0) {
              const seasonPoster = tmdbSeasonPosterMap.get(tmdbEpisode.seasonNumber);
              if (seasonPoster) {
                thumbnailUrl = seasonPoster;
              }
            }
            else {
              thumbnailUrl = null;
            }
          } else {
              thumbnailUrl = bestBackgroundUrl || `${host}/missing_thumbnail.png`;
          }
        }
        
        let episodeTitle = ep.canonicalTitle || ep.title;
        let key = tmdbEpisode ? `${tmdbEpisode.seasonNumber}:${tmdbEpisode.episodeNumber}` : null;
        if (!airDate && tmdbEpisode && key && !tmdbEpisode.isFranchiseFallback) {
          airDate = tmdbAirDateMap.get(key);
        }
        else if (!airDate && tmdbEpisode && key && tmdbEpisode.isFranchiseFallback) {
          logger.debug(`[buildKitsuAnimeResponse] Skipping TMDB air date for Kitsu ${kitsuData.id} Ep ${ep.number} because mapping is franchise fallback`);
        }
        if(!episodeTitle && tmdbEpisode && key && !tmdbEpisode.isFranchiseFallback) {
          episodeTitle = tmdbEpisodeTitleMap.get(key);
        } else if (!episodeTitle && tmdbEpisode && key && tmdbEpisode.isFranchiseFallback) {
          logger.debug(`[buildKitsuAnimeResponse] Skipping TMDB title fallback for Kitsu ${kitsuData.id} Ep ${ep.number} because mapping is franchise fallback`);
        }
        episodeTitle = episodeTitle || `Episode ${ep.number || ep.id}`;
        let episodeOverview = ep.synopsis || '';
        if(!episodeOverview && tmdbEpisode && key && !tmdbEpisode.isFranchiseFallback) {
          episodeOverview = tmdbEpisodeOverviewMap.get(key);
        } else if (!episodeOverview && tmdbEpisode && key && tmdbEpisode.isFranchiseFallback) {
          logger.debug(`[buildKitsuAnimeResponse] Skipping TMDB overview fallback for Kitsu ${kitsuData.id} Ep ${ep.number} because mapping is franchise fallback`);
        }
        episodeOverview = episodeOverview || ep.synopsis || '';
        // Build final thumbnail; keep null for upcoming episodes if no background/season poster available
        // Only apply local blur proxy when NOT using Top Poster API (Top Poster handles blur itself)
        const finalThumbnail = thumbnailUrl && config.blurThumbs && !usingTopPoster && thumbnailUrl !== `${host}/missing_thumbnail.png`
          ? `${host}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}`
          : thumbnailUrl;
        
        return {
          id: episodeId,
          title: episodeTitle,
          released: airDate
            ? createDateInTimezone(airDate, config.timezone || 'UTC')
            : null,
          overview: episodeOverview,
          thumbnail: finalThumbnail || (airDate && new Date(airDate) < new Date() ? `${host}/missing_thumbnail.png` : null),
          season: 1,
          episode: ep.number,
          available: airDate ? new Date(airDate) < new Date() : false,
          runtime: Utils.parseRunTime(ep.length)
        }
      }))

      // Enrich episodes with IMDb data if mapping exists
      if (imdbId && idProvider === 'imdb') {
        try {
          const enrichedVideos = await idMapper.enrichMalEpisodes(meta.videos, kitsuData.id, false);
          if (enrichedVideos && Array.isArray(enrichedVideos) && enrichedVideos.length > 0) {
            meta.videos = enrichedVideos;
            logger.debug(`[buildKitsuAnimeResponse] Successfully enriched ${enrichedVideos.length} episodes with IMDB data (preserving original IDs)`);
          } else if (enrichedVideos === null) {
            logger.debug(`[buildKitsuAnimeResponse] No IMDB enrichment available for kitsuId ${kitsuData.id}, using original videos`);
          } else {
            logger.warn(`[buildKitsuAnimeResponse] enrichMalEpisodes returned invalid data: ${JSON.stringify(enrichedVideos)}`);
          }
        } catch (error) {
          logger.error(`[buildKitsuAnimeResponse] Error enriching episodes: ${error.message}`);
          // Keep original videos if enrichment fails
        }
      }
    }

    return meta
  } catch (err) {
    logger.error(
      `Error processing Kitsu ID ${kitsuData?.id}: ${err?.message || err}`
    )
    return null
  }
}

module.exports = { getMeta };