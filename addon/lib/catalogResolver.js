const consola = require('consola');
const { getTrending } = require('./getTrending');
const { getFavorites, getWatchList } = require('./getPersonalLists');
const { cacheWrapMetaSmart, cacheWrapJikanApi, stableStringify } = require('./getCache');
const { getMeta } = require('./getMeta');
const { resolveAllIds } = require('./id-resolver');
const { getSearch } = require('./getSearch');
const { parseAnimeCatalogMetaBatch } = require('../utils/parseProps');
const jikan = require('./mal');
const tvmaze = require('./tvmaze');
const crypto = require('crypto');
const { getMergedChildAuthFingerprint } = require('./mergedAuthFingerprint');
const { buildMergedGenreRouting, normalizeMergedGenreValue } = require('./mergedGenreRouting');
const { buildMergedGenreRoutingContext } = require('./mergedGenreContext');

const logger = consola.withTag('CatalogResolver');

function getCatalogPageSize(cleanId, catalogConfig) {
  if (cleanId.includes('mal.')) return 25;
  if (cleanId === 'anilist.trending' || cleanId.startsWith('anilist.discover')) return 50;
  if (cleanId.startsWith('simkl.trending.')) {
    return typeof catalogConfig?.metadata?.pageSize === 'number'
      ? catalogConfig.metadata.pageSize
      : 50;
  }
  if (cleanId.startsWith('merge.')) {
    const mergedPageSize = Number(catalogConfig?.metadata?.merged?.pageSize);
    return Number.isFinite(mergedPageSize) && mergedPageSize > 0
      ? Math.floor(mergedPageSize)
      : parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20', 10);
  }
  if (
    cleanId.startsWith('simkl.watchlist.') ||
    cleanId.startsWith('stremthru.') ||
    cleanId.startsWith('mdblist.') ||
    cleanId.startsWith('custom.') ||
    cleanId.startsWith('trakt.') ||
    cleanId.startsWith('anilist.') ||
    cleanId.startsWith('letterboxd.') ||
    (cleanId.startsWith('tvdb.') && !cleanId.startsWith('tvdb.collection.'))
  ) {
    return parseInt(process.env.CATALOG_LIST_ITEMS_SIZE || '20', 10);
  }
  return 20;
}

function normalizeSkip(skip) {
  if (skip === undefined || skip === null || skip === '') return undefined;
  const parsed = parseInt(String(skip), 10);
  if (Number.isNaN(parsed) || parsed < 0) return undefined;
  return parsed;
}

async function buildMergedSignatureFromConfig(catalogConfig, fullConfig, actualType, language, genre) {
  if (!catalogConfig || !catalogConfig.id || !catalogConfig.id.startsWith('merge.')) return null;
  const mergedMeta = catalogConfig?.metadata?.merged;
  if (!mergedMeta || !Array.isArray(mergedMeta.children) || mergedMeta.children.length < 2) {
    return null;
  }

  const catalogs = fullConfig?.catalogs || [];
  const resolvedChildrenForRouting = [];
  const childSnapshots = mergedMeta.children.map((child) => {
    const resolved = catalogs.find(c => c.id === child.id && c.type === child.type);
    const authFingerprint = getMergedChildAuthFingerprint(resolved || child, fullConfig);
    if (!resolved) {
      return { id: child.id, type: child.type, missing: true, authFingerprint };
    }
    resolvedChildrenForRouting.push(resolved);
    return {
      id: resolved.id,
      type: resolved.type,
      source: resolved.source || null,
      sourceUrl: resolved.sourceUrl || null,
      pageSize: resolved.pageSize || null,
      sort: resolved.sort || null,
      order: resolved.order || null,
      sortDirection: resolved.sortDirection || null,
      cacheTTL: resolved.cacheTTL || null,
      metadata: resolved.metadata || null,
      displayType: resolved.displayType || null,
      enableRatingPosters: resolved.enableRatingPosters !== false,
      randomizePerPage: !!resolved.randomizePerPage,
      mergedInto: resolved.mergedInto || null,
      authFingerprint,
    };
  });
  const genreContext = await buildMergedGenreRoutingContext(resolvedChildrenForRouting, fullConfig, language);
  const genreRoutingHash = buildMergedGenreRouting(catalogConfig, resolvedChildrenForRouting, genreContext).hash;

  const normalizedGenre = normalizeMergedGenreValue(genre);
  const payload = {
    parent: {
      id: catalogConfig.id,
      type: catalogConfig.type,
      cacheTTL: catalogConfig.cacheTTL || null,
      enableRatingPosters: catalogConfig.enableRatingPosters !== false,
      merged: mergedMeta,
    },
    children: childSnapshots,
    request: {
      type: actualType,
      language: language || 'en-US',
      genre: normalizedGenre || 'all',
      genreRoutingHash: genreRoutingHash || null,
    },
  };

  return crypto.createHash('sha1').update(stableStringify(payload)).digest('hex');
}

async function resolveCatalog({
  cleanId,
  actualType,
  language,
  extraArgs = {},
  config,
  userUUID,
  includeVideos = false,
  sessionId,
  catalogConfig,
  fallbackGetCatalog,
}) {
  if (typeof fallbackGetCatalog !== 'function') {
    throw new Error('resolveCatalog requires fallbackGetCatalog callback');
  }

  const normalizedExtraArgs = { ...(extraArgs || {}) };
  if (cleanId === 'tvmaze.schedule') {
    const timezone = config?.timezone || process.env.TZ || 'UTC';
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    normalizedExtraArgs.date = normalizedExtraArgs.date || formatter.format(new Date());
    const normalizedScheduleGenre = normalizeMergedGenreValue(normalizedExtraArgs.genre);
    normalizedExtraArgs.genre = normalizedScheduleGenre
      ? String(normalizedScheduleGenre).toUpperCase()
      : '';
  }

  const { genre: genreName, type_filter, skip } = normalizedExtraArgs;
  const pageSize = getCatalogPageSize(cleanId, catalogConfig);
  const skipValue = normalizeSkip(skip);
  const page = skipValue !== undefined ? Math.floor(skipValue / pageSize) + 1 : 1;
  const args = [actualType, language, page];

  let metas = [];

  switch (cleanId) {
    case 'tmdb.trending':
      metas = (await getTrending(...args, genreName, config, userUUID, false)).metas;
      break;
    case 'tmdb.favorites':
      metas = (await getFavorites(...args, genreName, sessionId, config, userUUID, false)).metas;
      break;
    case 'tmdb.watchlist':
      metas = (await getWatchList(...args, genreName, sessionId, config, userUUID, false)).metas;
      break;
    case 'tvdb.collections': {
      const tvdbPage = Math.max(0, page - 1);
      metas = (await fallbackGetCatalog(actualType, language, tvdbPage, cleanId, genreName, config, userUUID, includeVideos, skipValue)).metas;
      break;
    }
    case 'mal.airing':
    case 'mal.upcoming':
    case 'mal.top_movies':
    case 'mal.top_series':
    case 'mal.most_favorites':
    case 'mal.most_popular':
    case 'mal.top_anime':
    case 'mal.80sDecade':
    case 'mal.90sDecade':
    case 'mal.00sDecade':
    case 'mal.10sDecade':
    case 'mal.20sDecade': {
      const decadeMap = {
        'mal.80sDecade': ['1980-01-01', '1989-12-31'],
        'mal.90sDecade': ['1990-01-01', '1999-12-31'],
        'mal.00sDecade': ['2000-01-01', '2009-12-31'],
        'mal.10sDecade': ['2010-01-01', '2019-12-31'],
        'mal.20sDecade': ['2020-01-01', '2029-12-31'],
      };
      if (cleanId === 'mal.airing') {
        const animeResults = await cacheWrapJikanApi(`mal-airing-${page}-${config.sfw}`, async () => {
          return await jikan.getAiringNow(page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
      } else if (cleanId === 'mal.upcoming') {
        const animeResults = await cacheWrapJikanApi(`mal-upcoming-${page}-${config.sfw}`, async () => {
          return await jikan.getUpcoming(page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
      } else if (cleanId === 'mal.top_movies') {
        const animeResults = await cacheWrapJikanApi(`mal-top-movies-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByType('movie', page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
      } else if (cleanId === 'mal.top_series') {
        const animeResults = await cacheWrapJikanApi(`mal-top-series-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByType('tv', page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
      } else if (cleanId === 'mal.most_popular') {
        const animeResults = await cacheWrapJikanApi(`mal-most-popular-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByFilter('bypopularity', page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
      } else if (cleanId === 'mal.most_favorites') {
        const animeResults = await cacheWrapJikanApi(`mal-most-favorites-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByFilter('favorite', page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
      } else if (cleanId === 'mal.top_anime') {
        const animeResults = await cacheWrapJikanApi(`mal-top-anime-${page}-${config.sfw}`, async () => {
          return await jikan.getTopAnimeByType('anime', page, config);
        }, null, { skipVersion: true });
        metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
      } else {
        const [startDate, endDate] = decadeMap[cleanId];
        const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
          return await jikan.getAnimeGenres();
        }, null, { skipVersion: true });
        const genreNameToFetch = genreName && genreName !== 'None' ? genreName : allAnimeGenres[0]?.name;
        if (genreNameToFetch) {
          const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
          if (selectedGenre) {
            const genreId = selectedGenre.mal_id;
            const animeResults = await cacheWrapJikanApi(`mal-${cleanId}-${page}-${genreId}-${config.sfw}`, async () => {
              return await jikan.getTopAnimeByDateRange(startDate, endDate, page, genreId, config);
            }, null, { skipVersion: true });
            metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
          }
        }
      }
      break;
    }
    case 'tvmaze.schedule': {
      const scheduleDate = normalizedExtraArgs.date;
      const scheduleCountry = normalizedExtraArgs.genre;
      const scheduleEntries = await tvmaze.getFullSchedule(scheduleDate, scheduleCountry);

      if (!Array.isArray(scheduleEntries) || scheduleEntries.length === 0) {
        metas = [];
        break;
      }

      const filteredEntries = scheduleEntries.filter(entry => {
        const showType = entry?.show?.type;
        return showType && showType.toLowerCase() !== 'news' && showType.toLowerCase() !== 'talk show';
      });

      const uniqueByShow = new Map();
      for (const entry of filteredEntries) {
        const showId = entry?.show?.id;
        if (!showId || uniqueByShow.has(showId)) continue;
        uniqueByShow.set(showId, entry);
      }

      const dedupedEntries = Array.from(uniqueByShow.values()).sort((a, b) => {
        const timeA = a?.airstamp ? new Date(a.airstamp).getTime() : 0;
        const timeB = b?.airstamp ? new Date(b.airstamp).getTime() : 0;
        return timeA - timeB;
      });

      const metasFromSchedule = await Promise.all(dedupedEntries.map(async (entry) => {
        const show = entry?.show;
        if (!show?.id) return null;

        let stremioId = `tvmaze:${show.id}`;
        try {
          const allIds = await resolveAllIds(stremioId, 'series', config);
          if (allIds) {
            if (allIds.imdbId) {
              stremioId = allIds.imdbId;
            } else if (allIds.tvdbId) {
              stremioId = `tvdb:${allIds.tvdbId}`;
            } else if (allIds.tmdbId) {
              stremioId = `tmdb:${allIds.tmdbId}`;
            }
          }
        } catch (_) {}

        try {
          const result = await cacheWrapMetaSmart(userUUID, stremioId, async () => {
            return await getMeta('series', language, stremioId, config, userUUID, true);
          }, undefined, { enableErrorCaching: true, maxRetries: 2 }, 'series', true);
          return result?.meta || null;
        } catch (error) {
          logger.warn(`[CatalogResolver] Failed to fetch meta for schedule entry ${stremioId}: ${error.message}`);
          return null;
        }
      }));

      const validScheduleMetas = metasFromSchedule.filter(Boolean);
      const startIndex = (page - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      metas = validScheduleMetas.slice(startIndex, endIndex);
      break;
    }
    case 'mal.genres': {
      const mediaType = type_filter || 'series';
      const allAnimeGenres = await cacheWrapJikanApi('anime-genres', async () => {
        return await jikan.getAnimeGenres();
      }, null, { skipVersion: true });
      const genreNameToFetch = genreName || allAnimeGenres[0]?.name;
      if (genreNameToFetch) {
        const selectedGenre = allAnimeGenres.find(g => g.name === genreNameToFetch);
        if (selectedGenre) {
          const genreId = selectedGenre.mal_id;
          const animeResults = await cacheWrapJikanApi(`mal-genre-${genreId}-${mediaType}-${page}-${config.sfw}`, async () => {
            return await jikan.getAnimeByGenre(genreId, mediaType, page, config);
          }, null, { skipVersion: true });
          metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        }
      }
      break;
    }
    case 'mal.studios': {
      if (genreName) {
        const studios = await cacheWrapJikanApi('mal-studios', () => jikan.getStudios(100), null, { skipVersion: true });
        const selectedStudio = studios.find(studio => {
          const defaultTitle = studio.titles.find(t => t.type === 'Default');
          return defaultTitle && defaultTitle.title === genreName;
        });
        if (selectedStudio) {
          const studioId = selectedStudio.mal_id;
          const animeResults = await cacheWrapJikanApi(`mal-studio-${studioId}-${page}-${config.sfw}`, async () => {
            return await jikan.getAnimeByStudio(studioId, page);
          }, null, { skipVersion: true });
          metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
        }
      }
      break;
    }
    case 'mal.schedule': {
      const dayOfWeek = genreName || 'Monday';
      const animeResults = await cacheWrapJikanApi(`mal-schedule-${dayOfWeek}-${page}-${config.sfw}`, async () => {
        return await jikan.getAiringSchedule(dayOfWeek, page, config);
      }, null, { skipVersion: true });
      metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
      break;
    }
    case 'mal.seasons': {
      let seasonString = genreName;
      if (!seasonString) {
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth();
        let currentSeason;
        if (currentMonth <= 2) currentSeason = 'Winter';
        else if (currentMonth <= 5) currentSeason = 'Spring';
        else if (currentMonth <= 8) currentSeason = 'Summer';
        else currentSeason = 'Fall';
        seasonString = `${currentSeason} ${currentYear}`;
      }

      const parts = seasonString.split(' ');
      const season = parts[0].toLowerCase();
      const year = parseInt(parts[1], 10);
      const animeResults = await cacheWrapJikanApi(`mal-season-${year}-${season}-${page}-${config.sfw}`, async () => {
        return await jikan.getAnimeBySeason(year, season, page, config);
      }, null, { skipVersion: true });
      metas = await parseAnimeCatalogMetaBatch(animeResults, config, language);
      break;
    }
    case 'mal.genre_search':
    case 'mal.va_search': {
      const searchResult = await getSearch(cleanId, actualType, language, normalizedExtraArgs, config);
      metas = searchResult.metas || [];
      break;
    }
    default:
      metas = (await fallbackGetCatalog(actualType, language, page, cleanId, genreName, config, userUUID, includeVideos, skipValue)).metas;
      break;
  }

  return metas || [];
}

module.exports = {
  buildMergedSignatureFromConfig,
  getCatalogPageSize,
  resolveCatalog,
};
