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
const fanart = require('../utils/fanart');
const e = require("express");
const { resolveAllIds } = require('./id-resolver');


const processLogo = (logoUrl) => {
  if (!logoUrl) return null;
  return logoUrl.replace(/^http:/, "https:");
};
const host = process.env.HOST_NAME.startsWith('http')
    ? process.env.HOST_NAME
    : `https://${process.env.HOST_NAME}`;

// --- Main Orchestrator ---
async function getMeta(type, language, stremioId, config = {}, catalogChoices) {
  try {
    let meta;
    console.log(`[Meta] Starting process for ${stremioId} (type: ${type}, language: ${language})`);
    const isAnime = stremioId.startsWith('mal:') || stremioId.startsWith('kitsu:') || stremioId.startsWith('anidb:') || stremioId.startsWith('anilist:');
    const finalType = isAnime ? 'anime' : type;
    switch (finalType) {
      case 'movie':
        meta = await getMovieMeta(config.providers?.movie, stremioId, language, config, catalogChoices);
        break;
      case 'series':
        meta = await getSeriesMeta(config.providers?.series, stremioId, language, config, catalogChoices);
        break;
      case 'anime':
        meta = await getAnimeMeta(config.providers?.anime, stremioId, language, config, catalogChoices, type);
        break;
    }
    return { meta };
  } catch (error) {
    console.error(`Failed to get meta for ${type} with ID ${stremioId}:`, error);
    return { meta: null };
  }
}


// --- Movie Worker ---
async function getMovieMeta(preferredProvider, stremioId, language, config, catalogChoices) {
  console.log(`[MovieMeta] Starting process for ${stremioId}. Preferred: ${preferredProvider}`);
  
  const allIds = await resolveAllIds(stremioId, 'movie', config);  
  if (preferredProvider === 'tvdb' && allIds.tvdbId) {
    try {
      const movieData = await tvdb.getMovieExtended(allIds.tvdbId, config);
      return buildTvdbMovieResponse(movieData, language, config, catalogChoices, { allIds }, config);
    } catch (e) {
      console.warn(`[MovieMeta] Preferred provider 'tvdb' failed for ${stremioId}. Falling back.`);
      console.error(`[MovieMeta] Detailed error for provider '${preferredProvider}':`, e);
    }
  }

  if (allIds.imdbId && preferredProvider === 'imdb') {
    try {
      let imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'movie');
      return buildImdbMovieResponse(imdbData, { allIds }, config);
    } catch (e) {
      console.warn(`[MovieMeta] Preferred provider 'imdb' failed for ${stremioId}. Falling back.`);
    }
  }

  if (allIds.tmdbId) {
    try {
      const movieData = await moviedb.movieInfo({ id: allIds.tmdbId, language, append_to_response: "videos,credits,external_ids" }, config);
      return buildTmdbMovieResponse(movieData, language, config, catalogChoices, { allIds });
    } catch (e) {
      console.error(`[MovieMeta] Native provider 'tmdb' also failed for ${stremioId}: ${e.message}`);
    }
  }
  
  return null;
}

async function getSeriesMeta(preferredProvider, stremioId, language, config, catalogChoices) {
  const allIds = await resolveAllIds(stremioId, 'series', config);
  console.log(`[SeriesMeta] Starting process for ${stremioId}. Preferred: ${preferredProvider}`);

  if (preferredProvider === 'tmdb' && allIds.tmdbId) {
    try {
      const seriesData = await moviedb.tvInfo({ id: allIds.tmdbId, language, append_to_response: "videos,credits,external_ids" }, config);
      return buildTmdbSeriesResponse(seriesData, language, config, catalogChoices, { allIds });
    } catch (e) {
      console.warn(`[SeriesMeta] Preferred provider 'tmdb' failed for ${stremioId}. Falling back.`);
    }
  }

  if (allIds.imdbId && preferredProvider === 'imdb') {
    try {
      let imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'series');
      return buildImdbSeriesResponse(imdbData, { allIds }, config);
    } catch (e) {
      console.warn(`[SeriesMeta] Preferred provider 'imdb' failed for ${stremioId}. Falling back.`);
    }
  }

  if (preferredProvider === 'tvmaze' && allIds.tvmazeId) {
    try {
      const seriesData = await tvmaze.getShowDetails(allIds.tvmazeId);
      return buildSeriesResponseFromTvmaze(seriesData, language, config, catalogChoices);
    } catch (e) {
      console.warn(`[SeriesMeta] Preferred provider 'tvmaze' failed for ${stremioId}. Falling back.`);
    }
  }

  if (allIds.tvdbId) {
    try {
      const [seriesData, episodes] = await Promise.all([
        tvdb.getSeriesExtended(allIds.tvdbId, config),
        tvdb.getSeriesEpisodes(allIds.tvdbId, language, config.tvdbSeasonType, config)
      ]);
      return buildTvdbSeriesResponse(seriesData, episodes, language, config, catalogChoices, { allIds });
    } catch (e) {
      console.error(`[SeriesMeta] Native provider 'tvdb' also failed for ${stremioId}: ${e.message}`);
    }
  }

  return null;
}

// --- Anime worker ---

async function getAnimeMeta(preferredProvider, stremioId, language, config, catalogChoices, animeType) {
  const allIds = await resolveAllIds(stremioId, 'anime', config, animeType);
  const malId = allIds.malId;
  const nativeProvider = 'mal';

    
    

  console.log(`[AnimeMeta] Starting process for ${stremioId}. Preferred: ${preferredProvider}`);

 
  

  if (preferredProvider !== nativeProvider) {
    try {
      if (preferredProvider === 'tmdb' && allIds.tmdbId) {
        //console.log(`[AnimeMeta] Attempting preferred provider TMDB with ID: ${allIds.tmdbId}`);
        const mapping = idMapper.getMappingByMalId(malId);
        const tmdbType = mapping?.type?.toLowerCase() === 'movie' ? 'movie' : 'series';
        
        if (tmdbType === 'movie') {
          const movieData = await moviedb.movieInfo({ id: allIds.tmdbId, language, append_to_response: "videos,credits,external_ids" }, config);
          return buildTmdbMovieResponse(movieData, language, config, catalogChoices, { allIds });
        } else {
          const seriesData = await moviedb.tvInfo({ id: allIds.tmdbId, language, append_to_response: "videos,credits,external_ids" }, config);
          return buildTmdbSeriesResponse(seriesData, language, config, catalogChoices, { allIds });
        }
      }
      
      if (preferredProvider === 'tvdb' && allIds.tvdbId) {
        if( animeType === 'series') {
          const [seriesData, episodes] = await Promise.all([
              tvdb.getSeriesExtended(allIds.tvdbId, config),
              tvdb.getSeriesEpisodes(allIds.tvdbId, language, config.tvdbSeasonType, config)
          ]);
          return buildTvdbSeriesResponse(seriesData, episodes, language, config, catalogChoices, { allIds });
        } else if (animeType === 'movie') {
          const movieData = await tvdb.getMovieExtended(allIds.tvdbId, config);
          return buildTvdbMovieResponse(movieData, language, config, catalogChoices, { allIds });
        }
      }

      if (preferredProvider === 'tvmaze' && allIds.tvmazeId) {
        //console.log(`[AnimeMeta] Attempting preferred provider TVmaze with ID: ${allIds.tvmazeId}`);
        const seriesData = await tvmaze.getShowDetails(allIds.tvmazeId);
        return buildSeriesResponseFromTvmaze(seriesData, language, config, catalogChoices);
      }
      if (preferredProvider === 'imdb' && allIds.imdbId) {
        if(animeType === 'anime'){
          animeType = idMapper.getAnimeTypeFromAnilistId(allIds.anilistId);
        }
        if(animeType === 'series') {
          let imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'series');
          return buildImdbSeriesResponse(imdbData, { allIds }, config);
          } else if(animeType === 'movie') {
            let imdbData = await imdb.getMetaFromImdb(allIds.imdbId, 'movie');
            return buildImdbMovieResponse(imdbData, { allIds }, config);
        }
      }

      console.log(`[AnimeMeta] No ID found for preferred provider '${preferredProvider}'. Falling back to MAL.`);

    } catch (e) {
      console.warn(`[AnimeMeta] Preferred provider '${preferredProvider}' failed for ${stremioId}. Falling back. Error: ${e.message}`);
    }
  }

  try {
    console.log(`[AnimeMeta] Using native provider 'mal' for ${stremioId}`);
    
    const [details, characters, episodes, episodeVideos] = await Promise.all([
      jikan.getAnimeDetails(allIds.malId),
      jikan.getAnimeCharacters(allIds.malId),
      jikan.getAnimeEpisodes(allIds.malId),
      jikan.getAnimeEpisodeVideos(allIds.malId)
    ]);
    
    if (!details) {
      throw new Error(`Jikan returned no core details for MAL ID ${allIds.malId}.`);
    }
    
    
    const background = await Utils.getAnimeBg({
      tvdbId: allIds.tvdbId,
      tmdbId: allIds.tmdbId,
      malId: allIds.malId,
      malPosterUrl: details.images?.jpg?.large_image_url,
      mediaType: details.type?.toLowerCase() === 'movie' ? 'movie' : 'series'
    }, config);
    
    // Get poster with art provider preference
    const poster = await Utils.getAnimePoster({
      malId: allIds.malId,
      malPosterUrl: details.images?.jpg?.large_image_url,
      mediaType: details.type?.toLowerCase() === 'movie' ? 'movie' : 'series'
    }, config);
    
    // Get logo with art provider preference
    const logo = await Utils.getAnimeLogo({
      malId: allIds.malId,
      mediaType: details.type?.toLowerCase() === 'movie' ? 'movie' : 'series'
    }, config);
    
    
    return buildAnimeResponse(details, language, characters, episodes, episodeVideos, config, catalogChoices, { 
      mapping: allIds, 
      bestBackgroundUrl: background,
      bestPosterUrl: poster,
      bestLogoUrl: logo
    });

  } catch (error) {
    console.error(`[AnimeMeta] CRITICAL: Native provider 'mal' also failed for ${stremioId}:`, error.message);
  }
  
  
  return null;
}

async function buildImdbSeriesResponse(imdbData, enrichmentData = {}, config) {
  const { allIds } = enrichmentData;
  const tmdbId = allIds?.tmdbId;
  const tvdbId = allIds?.tvdbId;
  const imdbPosterUrl = imdbData.poster;
  const imdbBackgroundUrl = imdbData.background;
  const imdbLogoUrl = imdbData.logo;
  const [poster, background, logoUrl] = await Promise.all([
    Utils.getSeriesPoster({ tmdbId: tmdbId, tvdbId: tvdbId, metaProvider: 'imdb', fallbackPosterUrl: imdbPosterUrl }, config),
    Utils.getSeriesBackground({ tmdbId: tmdbId, tvdbId: tvdbId, metaProvider: 'imdb', fallbackBackgroundUrl: imdbBackgroundUrl }, config),
    Utils.getSeriesLogo({ tmdbId: tmdbId, tvdbId: tvdbId, metaProvider: 'imdb', fallbackLogoUrl: imdbLogoUrl }, config),
  ]);

  imdbData.poster = poster;
  imdbData.background = background;
  imdbData.logo = logoUrl;

  return imdbData;
}

async function buildImdbMovieResponse(imdbData, enrichmentData = {}, config) {
  const { allIds } = enrichmentData;
  const tmdbId = allIds?.tmdbId;
  const tvdbId = allIds?.tvdbId;
  const imdbPosterUrl = imdbData.poster || null;
  const imdbBackgroundUrl = imdbData.background || null;
  const imdbLogoUrl = imdbData.logo || null;
  const [poster, background, logoUrl] = await Promise.all([
    Utils.getMoviePoster({ tmdbId: tmdbId, tvdbId: tvdbId, metaProvider: 'imdb', fallbackPosterUrl: imdbPosterUrl }, config),
    Utils.getMovieBackground({ tmdbId: tmdbId, tvdbId: tvdbId, metaProvider: 'imdb', fallbackBackgroundUrl: imdbBackgroundUrl }, config),
    Utils.getMovieLogo({ tmdbId: tmdbId, tvdbId: tvdbId, metaProvider: 'imdb', fallbackLogoUrl: imdbLogoUrl }, config),
  ]);

  imdbData.poster = poster;
  imdbData.background = background;
  imdbData.logo = logoUrl;

  return imdbData;
}

async function buildTvdbMovieResponse(movieData, language, config, catalogChoices, enrichmentData = {}) {
  const tvdbId = movieData.id;
  const imdbId = movieData.remoteIds?.find(id => id.sourceName === 'IMDB')?.id;
  const tmdbId = movieData.remoteIds?.find(id => id.sourceName === 'TheMovieDB.com')?.id;
  const { allIds } = enrichmentData;
  const kitsuId = allIds?.kitsuId;

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

  const castCount = config.castCount === 0 ? undefined : config.castCount;

  // Get artwork based on art provider preference
  const tvdbPosterUrl = tvdbPosterPath ? `${tvdbPosterPath}` : `https://artworks.thetvdb.com/banners/images/missing/movie.jpg`;
  const tvdbBackgroundUrl = movieData.artworks?.find(a => a.type === 15)?.image;
  const tvdbLogoUrl = movieData.artworks?.find(a => a.type === 25)?.image;
  const [poster, background, logoUrl, imdbRatingValue] = await Promise.all([
    Utils.getMoviePoster({ tmdbId: tmdbId?.toString(), tvdbId: tvdbId?.toString(), metaProvider: 'tvdb', fallbackPosterUrl: tvdbPosterUrl }, config),
    Utils.getMovieBackground({ tmdbId: tmdbId?.toString(), tvdbId: tvdbId?.toString(), metaProvider: 'tvdb', fallbackBackgroundUrl: tvdbBackgroundUrl }, config),
    Utils.getMovieLogo({ tmdbId: tmdbId?.toString(), tvdbId: tvdbId?.toString(), metaProvider: 'tvdb', fallbackLogoUrl: tvdbLogoUrl }, config),
    getImdbRating(imdbId, 'movie')
  ]);
  const imdbRating = imdbRatingValue || "N/A";
  
  const fallbackPosterUrl = poster || tvdbPosterUrl || `https://artworks.thetvdb.com/banners/images/missing/movie.jpg`;
  const posterProxyUrl = `${host}/poster/movie/tvdb:${movieData.id}?fallback=${encodeURIComponent(fallbackPosterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
  const tmdbLikeCredits = {
    cast: (characters || []).map(c => ({
      name: c.personName,
      character: c.name,
      profile_path: c.image 
    })),
    crew: []
  };
  
  const { trailers, trailerStreams } = Utils.parseTvdbTrailers(movieData.trailers, translatedName);

  return {
    id: `tvdb:${tvdbId}`,
    type: 'movie',
    name: translatedName,
    imdb_id: imdbId,
    slug: Utils.parseSlug('movie', translatedName, null, `tvdb:${tvdbId}`),
    genres: movieData.genres?.map(g => g.name) || [],
    description: overview,
    year: year,
    releaseInfo: year,
    released: movieData.first_release.Date ? new Date(movieData.first_release.Date) : null,
    runtime: Utils.parseRunTime(movieData.runtime),
    country: movieData.originalCountry,
    imdbRating,
    poster: config.apiKeys?.rpdb ? posterProxyUrl : poster,
    background: background,
    logo: processLogo(logoUrl),
    trailers: trailers,
    trailerStreams: trailerStreams,
    behaviorHints: {
      defaultVideoId: kitsuId ? `kitsu:${kitsuId}` : imdbId || `tvdb:${tvdbId}`,
      hasScheduledVideos: false
    },
    links: Utils.buildLinks(imdbRating, imdbId, translatedName, 'movie', movieData.genres, tmdbLikeCredits, language, castCount, catalogChoices, true),
    app_extras: { cast: Utils.parseCast(tmdbLikeCredits, castCount) }
  };
}

async function buildTmdbMovieResponse(movieData, language, config, catalogChoices, enrichmentData = {}) {
  const { allIds } = enrichmentData;
  const { id: tmdbId, title, external_ids, poster_path, backdrop_path, credits } = movieData;
  const imdbId = external_ids?.imdb_id;
  const tvdbId = allIds?.tvdbId;
  const castCount = config.castCount === 0 ? undefined : config.castCount;
  
  // Get artwork based on art provider preference
  const tmdbPosterUrl = poster_path ? `https://image.tmdb.org/t/p/w500${poster_path}` : `https://artworks.thetvdb.com/banners/images/missing/movie.jpg`;
  const tmdbBackgroundUrl = backdrop_path ? `https://image.tmdb.org/t/p/original${backdrop_path}` : null;
  let tmdbLogoUrl = null;
  if (Array.isArray(movieData.logos) && movieData.logos.length > 0) {
    tmdbLogoUrl =
      movieData.logos.find(l => l.iso_639_1 === language.split('-')[0])?.file_path ||
      movieData.logos.find(l => l.iso_639_1 === 'en')?.file_path ||
      movieData.logos[0].file_path;
  }
  
  const [poster, background, logoUrl, imdbRatingValue] = await Promise.all([
    Utils.getMoviePoster({ tmdbId, tvdbId, metaProvider: 'tmdb', fallbackPosterUrl: tmdbPosterUrl }, config),
    Utils.getMovieBackground({ tmdbId, tvdbId, metaProvider: 'tmdb', fallbackBackgroundUrl: tmdbBackgroundUrl }, config),
    Utils.getMovieLogo({ tmdbId, tvdbId, metaProvider: 'tmdb', fallbackLogoUrl: tmdbLogoUrl }, config),
    getImdbRating(imdbId, 'movie')
  ]);
  
  const imdbRating = imdbRatingValue || movieData.vote_average?.toFixed(1) || "N/A";
  const posterProxyUrl = `${host}/poster/movie/tmdb:${movieData.id}?fallback=${encodeURIComponent(poster)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
  const kitsuId = allIds?.kitsuId;
  const idProvider = config.providers?.movie || 'imdb';
  
  return {
    id: `tmdb:${tmdbId}`,
    type: 'movie',
    description: movieData.overview,
    name: title,
    imdb_id: imdbId,  
    slug: Utils.parseSlug('movie', title, null, `tmdb:${tmdbId}`),
    genres: Utils.parseGenres(movieData.genres),
    director: Utils.parseDirector(credits).join(', '),
    writer: Utils.parseWriter(credits).join(', '),
    year: movieData.release_date ? movieData.release_date.substring(0, 4) : "",
    released: new Date(movieData.release_date),
    releaseInfo: movieData.release_date ? movieData.release_date.substring(0, 4) : "",
    runtime: Utils.parseRunTime(movieData.runtime),
    country: Utils.parseCoutry(movieData.production_countries),
    imdbRating,
    poster: config.apiKeys?.rpdb ? posterProxyUrl : poster,
    background: background,
    logo: processLogo(logoUrl),
    trailers: Utils.parseTrailers(movieData.videos),
    trailerStreams: Utils.parseTrailerStream(movieData.videos),
    links: Utils.buildLinks(imdbRating, imdbId, title, 'movie', movieData.genres, credits, language, castCount, catalogChoices),
    behaviorHints: { defaultVideoId: kitsuId && idProvider === 'kitsu' ? `kitsu:${kitsuId}` : imdbId || `tmdb:${tmdbId}`, hasScheduledVideos: false },
    app_extras: { cast: Utils.parseCast(credits, castCount) }
  };
}


async function buildTmdbSeriesResponse(seriesData, language, config, catalogChoices, enrichmentData = {}) {
  const { id: tmdbId, name, external_ids, poster_path, backdrop_path, credits, videos: trailers, seasons } = seriesData;
  const { allIds } = enrichmentData;
  const imdbId = allIds?.imdbId;
  const tvdbId = allIds?.tvdbId;
  const kitsuId = allIds?.kitsuId;
  const malId = allIds?.malId;

  const idProvider = config.providers?.anime_id_provider || 'imdb';

  // Get artwork based on art provider preference
  const tmdbPosterUrl = poster_path ? `https://image.tmdb.org/t/p/w500${poster_path}` : `https://artworks.thetvdb.com/banners/images/missing/series.jpg`;
  const tmdbBackgroundUrl = backdrop_path ? `https://image.tmdb.org/t/p/original${backdrop_path}` : null;
  let tmdbLogoUrl = null;
  if (Array.isArray(seriesData.logos) && seriesData.logos.length > 0) {
    tmdbLogoUrl =
      seriesData.logos.find(l => l.iso_639_1 === language.split('-')[0])?.file_path ||
      seriesData.logos.find(l => l.iso_639_1 === 'en')?.file_path ||
      seriesData.logos[0].file_path;
  }
  const [poster, background, logoUrl, imdbRatingValue] = await Promise.all([
    Utils.getSeriesPoster({ tmdbId, tvdbId, metaProvider: 'tmdb', fallbackPosterUrl: tmdbPosterUrl }, config),
    Utils.getSeriesBackground({ tmdbId, tvdbId, metaProvider: 'tmdb', fallbackBackgroundUrl: tmdbBackgroundUrl }, config),
    Utils.getSeriesLogo({ tmdbId, tvdbId, metaProvider: 'tmdb', fallbackLogoUrl: tmdbLogoUrl }, config),
    imdbId ? getImdbRating(imdbId, 'series') : Promise.resolve(null)
  ]);
  
  const posterProxyUrl = `${host}/poster/series/tmdb:${tmdbId}?fallback=${encodeURIComponent(poster)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
  const imdbRating = imdbRatingValue || seriesData.vote_average?.toFixed(1) || "N/A";
  const castCount = config.castCount === 0 ? undefined : config.castCount;

  // Build season-to-Kitsu mapping for anime series
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
    console.log(`[ID Builder] Built Season-to-Kitsu map for tmdb:${tmdbId}:`, seasonToKitsuIdMap);
  }
  
  // Fetch Cinemeta videos data for IMDB episode mapping (once per IMDB series)
  let cinemetaVideos = null;
  if (imdbId && config.providers?.anime_id_provider === 'imdb') {
    try {
      cinemetaVideos = await idMapper.getCinemetaVideosForImdbSeries(imdbId);
      if (cinemetaVideos) {
        console.log(`[ID Builder] Fetched ${cinemetaVideos.length} Cinemeta videos for IMDB ${imdbId}`);
      }
    } catch (error) {
      console.warn(`[ID Builder] Failed to fetch Cinemeta videos for IMDB ${imdbId}:`, error.message);
    }
  }

  const seasonPromises = (seasons || [])
    .filter(season => season.season_number > 0 && season.episode_count > 0) 
    .map(season => moviedb.seasonInfo({ id: tmdbId, season_number: season.season_number, language }, config));
  
  const seasonDetails = await Promise.all(seasonPromises);
  
  const videosPromises = seasonDetails.flatMap(season => 
    (season.episodes || []).map(async ep => {
      let episodeId = null; 
      if(ep.season_number === 0) {
        episodeId = `${imdbId || `tmdb:${tmdbId}`}:0:${ep.episode_number}`;
      } else{
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
                console.log(`[ID Builder] Episode-level mapping: TMDB S${ep.season_number}E${ep.episode_number} → Kitsu ID ${episodeMapping.kitsuId} E${episodeMapping.episodeNumber}`);
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
          if (imdbId && ep.air_date && cinemetaVideos) {
            const imdbEpisodeId = idMapper.getImdbEpisodeIdFromTmdbEpisode(tmdbId, ep.season_number, ep.episode_number, ep.air_date, cinemetaVideos);
            if (imdbEpisodeId) {
              episodeId = imdbEpisodeId;
            } else {
              // Fallback to main IMDB ID
              episodeId = `${imdbId}:${ep.season_number}:${ep.episode_number}`;
            }
          } else {
            // Fallback to main IMDB ID
            episodeId = `${imdbId}:${ep.season_number}:${ep.episode_number}`;
          }
        }
      }
      
      if (!episodeId) {
        episodeId = `tmdb:${tmdbId}:${ep.season_number}:${ep.episode_number}`;
      }

      const thumbnailUrl = ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : poster;
      const finalThumbnail = config.blurThumbs && thumbnailUrl
        ? `${host}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}`
        : thumbnailUrl;
      
      return {
        id: episodeId,
        title: ep.name || `Episode ${ep.episode_number}`,
        season: ep.season_number,
        episode: ep.episode_number,
        released: ep.air_date ? new Date(ep.air_date).toISOString() : null,
        overview: ep.overview,
        thumbnail: finalThumbnail,
      };
    })
  );
  
  const videos = (await Promise.all(videosPromises)).filter(Boolean);

  return {
    id: `tmdb:${tmdbId}`,
    type: 'series',
    name: name,
    imdb_id: imdbId,
    slug: Utils.parseSlug('series', name, null, `tmdb:${tmdbId}`),
    genres: Utils.parseGenres(seriesData.genres),
    description: seriesData.overview,
    year: seriesData.first_air_date ? seriesData.first_air_date.substring(0, 4) : "",
    released: seriesData.first_air_date ? new Date(seriesData.first_air_date).toISOString() : null,
    runtime: seriesData.episode_run_time?.[0] ? `${seriesData.episode_run_time[0]}min` : null,
    status: seriesData.status,
    imdbRating,
    poster: config.apiKeys?.rpdb ? posterProxyUrl : poster,
    background: background,
    logo: logoUrl,
    trailers: Utils.parseTrailers(trailers),
    links: Utils.buildLinks(imdbRating, imdbId, name, 'series', seriesData.genres, credits, language, castCount, catalogChoices),
    videos: videos,
    behaviorHints: {
      defaultVideoId: null,
      hasScheduledVideos: true,
    },
    app_extras: { cast: Utils.parseCast(credits, castCount) }
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
    console.log(`[ID Builder] Built absolute-to-seasonal map for tvdb:${tvdbShow.id}`);
  }
  return seasonLayoutMap;
}

async function buildTvdbSeriesResponse(tvdbShow, tvdbEpisodes, language, config, catalogChoices, enrichmentData = {}) {
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
  const imdbId = remoteIds?.find(id => id.sourceName === 'IMDB')?.id;
  const tmdbId = remoteIds?.find(id => id.sourceName === 'TheMovieDB.com')?.id;
  const tvdbId = tvdbShow.id;
  const malId = allIds?.malId;
  const castCount = config.castCount === 0 ? undefined : config.castCount;

  // Get artwork based on art provider preference
  const tvdbPosterUrl = tvdbPosterPath ? `${tvdbPosterPath}` : null;
  const tvdbBackgroundUrl = tvdbShow.artworks?.find(a => a.type === 3)?.image;
  const tvdbLogoUrl = tvdbShow.artworks?.find(a => a.type === 25)?.image;
  const [poster, background, logoUrl, imdbRatingValue] = await Promise.all([
    Utils.getSeriesPoster({ tmdbId: tmdbId, tvdbId: tvdbId, metaProvider: 'tvdb', fallbackPosterUrl: tvdbPosterUrl }, config),
    Utils.getSeriesBackground({ tmdbId: tmdbId, tvdbId: tvdbId, metaProvider: 'tvdb', fallbackBackgroundUrl: tvdbBackgroundUrl }, config),
    Utils.getSeriesLogo({ tmdbId: tmdbId, tvdbId: tvdbId, metaProvider: 'tvdb', fallbackLogoUrl: tvdbLogoUrl }, config),
    getImdbRating(imdbId, 'series')
  ]);
  const imdbRating = imdbRatingValue || "N/A";
  const fallbackPosterUrl = poster || tvdbPosterUrl || `https://artworks.thetvdb.com/banners/images/missing/series.jpg`;
  const posterProxyUrl = `${host}/poster/series/tvdb:${tvdbShow.id}?fallback=${encodeURIComponent(fallbackPosterUrl)}&lang=${language}&key=${config.apiKeys?.rpdb}`;
  const tmdbLikeCredits = {
    cast: (characters || []).map(c => ({
      name: c.personName,
      character: c.name,
      profile_path: c.image 
    })),
    crew: []
  };

  const { trailers, trailerStreams } = Utils.parseTvdbTrailers(tvdbShow.trailers, translatedName);

  const seasonToKitsuIdMap = new Map();
  const absoluteToSeasonalMap = new Map();

  if (enrichmentData.allIds?.malId) {
    const officialSeasons = (tvdbShow.seasons || [])
      .filter(s => s.type?.type === 'official' && s.number > 0)
      .sort((a, b) => a.number - b.number);

    const seasonDetailPromises = officialSeasons.map(s => tvdb.getSeasonExtended(s.id, config));
    const detailedSeasons = (await Promise.all(seasonDetailPromises)).filter(Boolean);

    const kitsuMapPromises = detailedSeasons.map(async (season) => {
        const seasonalKitsuId = await idMapper.resolveKitsuIdFromTvdbSeason(tvdbId, season.number);
        if (seasonalKitsuId) {
            seasonToKitsuIdMap.set(season.number, seasonalKitsuId);
        }
    });
    await Promise.all(kitsuMapPromises);
    console.log(`[ID Builder] Built Season-to-Kitsu map for tvdb:${tvdbId}:`, seasonToKitsuIdMap);

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
  
  
  const videos = await Promise.all(
    (tvdbEpisodes.episodes || []).map(async (episode) => {
        const thumbnailUrl = episode.image ? `${TVDB_IMAGE_BASE}${episode.image}` : null;
        const finalThumbnail = config.blurThumbs && thumbnailUrl
            ? `${host}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}`
            : thumbnailUrl;
        let episodeId;
        if (episode.seasonNumber === 0) {
          episodeId = `${imdbId || `tvdb:${tvdbId}`}:0:${episode.number}`;
        } 
        else if (kitsuId && config.providers?.anime_id_provider === 'kitsu') {
          if ((config.tvdbSeasonType === 'default' || config.tvdbSeasonType === 'official')){
            const seasonalKitsuId = await idMapper.resolveKitsuIdFromTvdbSeason(tvdbId, episode.seasonNumber);        
            if (seasonalKitsuId) {
              episodeId = `kitsu:${seasonalKitsuId}:${episode.number}`;
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
        else if(malId && config.providers?.anime_id_provider === 'mal') {
          if ((config.tvdbSeasonType === 'default' || config.tvdbSeasonType === 'official')){
            const seasonalKitsuId = await idMapper.resolveKitsuIdFromTvdbSeason(tvdbId, episode.seasonNumber);
            const seasonalMalId = await idMapper.getMappingByKitsuId(seasonalKitsuId)?.mal;
            if (seasonalMalId) {
              episodeId = `mal:${seasonalMalId}:${episode.number}`;
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
            released: episode.aired ? new Date(episode.aired) : null,
            available: episode.aired ? new Date(episode.aired) < new Date() : false,
        };
      })
  );
 
  //console.log(tvdbShow.artworks?.find(a => a.type === 2)?.image);
  const meta = {
    id: `tvdb:${tvdbId}`,
    type: 'series',
    name: translatedName,
    imdb_id: imdbId,
    slug: Utils.parseSlug('series', translatedName, imdbId),
    genres: tvdbShow.genres?.map(g => g.name) || [],
    description: overview,
    writer: (tvdbShow.companies?.production || []).map(p => p.name).join(', '),
    year: year,
    released: new Date(tvdbShow.firstAired),
    runtime: Utils.parseRunTime(tvdbShow.averageRuntime),
    status: tvdbShow.status?.name,
    country: tvdbShow.originalCountry,
    imdbRating,
    poster: config.apiKeys?.rpdb ? posterProxyUrl : poster,
    background: background, 
    logo: processLogo(logoUrl),
    videos: videos,
    trailers: trailers,
    trailerStreams: trailerStreams,
    links: Utils.buildLinks(imdbRating, imdbId, translatedName, 'series', tvdbShow.genres, tmdbLikeCredits, language, castCount, catalogChoices, true),
    behaviorHints: { defaultVideoId: null, hasScheduledVideos: true },
    app_extras: { cast: Utils.parseCast(tmdbLikeCredits, castCount) }
  };
  //console.log(Utils.parseCast(tmdbLikeCredits, castCount));
  return meta;
}

async function buildSeriesResponseFromTvmaze(tvmazeShow, language, config, catalogChoices) {
  const { name, premiered, image, summary, externals } = tvmazeShow;
  const imdbId = externals.imdb;
  const tmdbId = externals.themoviedb;
  const tvdbId = externals.thetvdb;
  const castCount = config.castCount === 0 ? undefined : config.castCount;

  const [logoUrl, imdbRatingValue] = await Promise.all([
    getLogo('series', { tmdbId, tvdbId }, language, tvmazeShow.language, config),
    getImdbRating(imdbId, 'series')
  ]);
  const imdbRating = imdbRatingValue || tvmazeShow.rating?.average?.toFixed(1) || "N/A";

  const tmdbLikeCredits = {
    cast: (tvmazeShow?._embedded?.cast || []).map(c => ({
      name: c.person.name, character: c.character.name, profile_path: c.person.image?.medium.replace('https://static.tvmaze.com/uploads/images/', '')
    })),
    crew: (tvmazeShow?._embedded?.cast || []).filter(c => c.type === 'Creator').map(c => ({
        name: c.person.name, job: 'Creator'
    }))
  };

  const posterProxyUrl = `${host}/poster/series/${imdbId}?fallback=${encodeURIComponent(image?.original || '')}&lang=${language}&key=${config.apiKeys?.rpdb}`;

  const videos = (tvmazeShow?._embedded?.episodes || []).map(episode => ({
    id: `${imdbId}:${episode.season}:${episode.number}`,
    title: episode.name || `Episode ${episode.number}`,
    season: episode.season,
    episode: episode.number,
    thumbnail: config.blurThumbs && episode.image?.medium
      ? `${process.env.HOST_NAME}/api/image/blur?url=${encodeURIComponent(episode.image.medium)}`
      : episode.image?.medium || image?.medium,
    overview: episode.summary ? episode.summary.replace(/<[^>]*>?/gm, '') : '',
    released: new Date(episode.airstamp),
    available: new Date(episode.airstamp) < new Date(),
  }));

  const meta = {
    id: imdbId? imdbId : tvdbId ? `tvdb:${tvdbId}` : `tmdb:${tmdbId}`,
    type: 'series', 
    name: name, 
    imdb_id: imdbId,
    slug: Utils.parseSlug('series', name, imdbId),
    genres: tvmazeShow.genres || [],
    description: summary ? summary.replace(/<[^>]*>?/gm, '') : '',
    writer: Utils.parseWriter(tmdbLikeCredits).join(', '),
    year: Utils.parseYear(tvmazeShow.status, premiered, tvmazeShow.ended),
    released: new Date(premiered),
    runtime: tvmazeShow.runtime ? Utils.parseRunTime(tvmazeShow.runtime) : Utils.parseRunTime(tvmazeShow.averageRuntime),
    status: tvmazeShow.status,
    country: tvmazeShow.network?.country?.name || null,
    imdbRating,
    poster: config.apiKeys?.rpdb ? posterProxyUrl : image?.original, background: image?.original,
    logo: processLogo(logoUrl), videos,
    links: Utils.buildLinks(imdbRating, imdbId, name, 'series', tvmazeShow.genres.map(g => ({ name: g })), tmdbLikeCredits, language, castCount, catalogChoices),
    behaviorHints: { defaultVideoId: null, hasScheduledVideos: true },
  };

  return meta;
}


async function buildAnimeResponse(malData, language, characterData, episodeData, episodeVideoData, config, catalogChoices, enrichmentData = {}) {
  try {
    const { mapping, bestBackgroundUrl } = enrichmentData;
    const stremioType = malData.type.toLowerCase() === 'movie' ? 'movie' : 'series';
    const imdbId = mapping?.imdbId;
    const kitsuId = mapping?.kitsuId;
    const imdbRating = typeof malData.score === 'number' ? malData.score.toFixed(1) : "N/A";
    const castCount = config.castCount === 0 ? undefined : config.castCount;  
    let videos = [];
    const seriesId = `mal:${malData.mal_id}`;
    const idProvider = config.providers?.anime_id_provider || 'kitsu';
    let primaryId = seriesId; 
    if (idProvider === 'kitsu' && kitsuId) {
      primaryId = `kitsu:${kitsuId}`;
    }
    const posterUrl = malData.images?.jpg?.large_image_url;
    
    // Use AniList poster if available and configured
    let finalPosterUrl = enrichmentData.bestPosterUrl || posterUrl; 

    if (config.apiKeys?.rpdb && mapping) {
      const tvdbId = mapping.tvdbId;
      const tmdbId = mapping.tmdbId;
      let proxyId = null;
      let proxyType = stremioType;

      if (stremioType === 'series') {
        if (tvdbId) {
          proxyId = `tvdb:${tvdbId}`;
        } else if (tmdbId) {
          proxyId = `tmdb:${tmdbId}`; 
        }
      } else if (stremioType === 'movie') {
        if (tmdbId) {
          proxyId = `tmdb:${tmdbId}`;
        }
      }

      if (proxyId) {
        const fallback = encodeURIComponent(posterUrl);
        finalPosterUrl = `${host}/poster/${proxyType}/${proxyId}?fallback=${fallback}&lang=${language}&key=${config.apiKeys?.rpdb}`;
        console.log(`[buildAnimeResponse] Constructed RPDB Poster Proxy URL: ${finalPosterUrl}`);
      }
    }
    
    const thumbnailMap = new Map();
    if (episodeVideoData && episodeVideoData.length > 0) {
      episodeVideoData.forEach(video => {
        if (video.mal_id) {
          thumbnailMap.set(video.mal_id, video.images?.jpg?.image_url || null);
        }
      });
    }
    
    if (stremioType === 'series' && malData.status !== 'Not yet aired' && episodeData && episodeData.length > 0) {
      videos = (episodeData || [])
          .filter(ep => {
            if (config.mal?.skipFiller && ep.filler) {
              return false;
            }
            if (config.mal?.skipRecap && ep.recap) {
              return false;
            }
            return true;
          })
          .map(ep => {
            let episodeId = `${seriesId}:${ep.mal_id}`;
            if (idProvider === 'kitsu' && kitsuId) {
              episodeId = `kitsu:${kitsuId}:${ep.mal_id}`;
            } else if (idProvider === 'imdb' && imdbId) {
              episodeId = `${imdbId}:${ep.season || 1}:${ep.mal_id}`;
            } 
          const thumbnailUrl = thumbnailMap.get(ep.mal_id) || posterUrl;
          return {
            id:  episodeId,
            title: ep.title,
            season: 1,
            episode: ep.mal_id,
            released: ep.aired? new Date(ep.aired) : null,
            thumbnail: config.blurThumbs? `${process.env.HOST_NAME}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}` : thumbnailUrl,
            available: ep.aired ? new Date(ep.aired) < new Date() : false
          };
        });
      if (idProvider === 'imdb' && kitsuId) {
        const imdbSeasonInfo = await idMapper.resolveImdbSeasonFromKitsu(kitsuId);

        if (imdbSeasonInfo) {
          videos = (episodeData || [])
            .filter(ep => {
              if (config.mal?.skipFiller && ep.filler) {
                return false;
              }
              if (config.mal?.skipRecap && ep.recap) {
                return false;
              }
              return true;
            }).map(ep => {
              const thumbnailUrl = thumbnailMap.get(ep.mal_id) || posterUrl;
              return {
                id: `${imdbSeasonInfo.imdbId}:${imdbSeasonInfo.seasonNumber}:${ep.mal_id}`,
                title: ep.title,
                season: 1,
                episode: ep.mal_id,
                released: ep.aired? new Date(ep.aired) : null,
                thumbnail: config.blurThumbs? `${process.env.HOST_NAME}/api/image/blur?url=${encodeURIComponent(thumbnailUrl)}` : thumbnailUrl,
                available: ep.aired ? new Date(ep.aired) < new Date() : false
              };
            });
        }
      } 
    }

    const tmdbLikeCredits = {
      cast: (characterData || [])
        .map(charEntry => {
          const voiceActor = charEntry.voice_actors.find(va => va.language === 'Japanese');
          if (!voiceActor) return null;
          return {
            name: voiceActor.person.name.replace(",", ""),
            profile_path: voiceActor.person.images.jpg.image_url,
            character: charEntry.character.name.replace(",", ""),
          };
        })
        .filter(Boolean),
      crew: []
    };

    const trailerStreams = [];
    if (malData.trailer?.youtube_id) {
      trailerStreams.push({
        ytId: malData.trailer.youtube_id,
        title: malData.title_english || malData.title
      });
    }
    const trailers = [];
    if (malData.trailer?.youtube_id) {
      trailers.push({
        source: malData.trailer.youtube_id,
        type: "Trailer",
        name: malData.title_english || malData.title
      });
    }

    const links = [];

    if (imdbId) {
      links.push(Utils.parseImdbLink(imdbRating, imdbId));
      links.push(Utils.parseShareLink(malData.title, imdbId, stremioType));
    }

    links.push(...Utils.parseAnimeGenreLink(malData.genres, stremioType, catalogChoices));
    links.push(...Utils.parseAnimeCreditsLink(characterData, catalogChoices, castCount));
    links.push(...Utils.parseAnimeRelationsLink(malData.relations, stremioType, catalogChoices));
 
    return {
      id: kitsuId ? `kitsu:${kitsuId}` : `mal:${malData.mal_id}`,
      type: stremioType,
      description: malData.synopsis,
      name: malData.title_english || malData.title,
      imdb_id: imdbId,
      slug: Utils.parseSlug('series', malData.title_english || malData.title, imdbId, malData.mal_id),
      genres: malData.genres?.map(g => g.name) || [],
      year: malData.year || malData.aired?.from?.substring(0, 4),
      released: new Date(malData.aired?.from || malData.start_date),
      runtime: Utils.parseRunTime(malData.duration),
      status: malData.status,
      imdbRating,
      poster: finalPosterUrl,
      background: bestBackgroundUrl,
      logo: enrichmentData.bestLogoUrl,
      links: links.filter(Boolean),
      trailers: trailers,
      trailerStreams: trailerStreams,
      releaseInfo: malData.year,
      director: [],
      writers: [],
      behaviorHints: {
        defaultVideoId: stremioType === 'movie' ? ((kitsuId && idProvider === 'kitsu') ? `kitsu:${kitsuId}` : null) || (imdbId && idProvider === 'imdb') ? `imdb:${imdbId}` : seriesId : null,
        hasScheduledVideos: stremioType === 'series',
      },
      videos: videos,
      app_extras: {
        cast: Utils.parseCast(tmdbLikeCredits, castCount)
      }
    };

  } catch (err) {
    console.error(`Error processing MAL ID ${malData?.mal_id}:`, err);
    return null;
  }
}

module.exports = { getMeta };
