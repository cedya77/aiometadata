const consola = require('consola');
const { getGenreList } = require('./getGenreList');
const { getLanguages } = require('./getLanguages');
const { cacheWrapJikanApi } = require('./getCache');
const { fetchMDBListGenres } = require('../utils/mdbList');
const { fetchTraktGenres } = require('../utils/traktUtils');
const {
  getContextRequirementsForCatalog,
  getMdbListSelectionNeeds,
} = require('./mergedGenreCatalogProfiles');
const jikan = require('./mal');

const logger = consola.withTag('MergedGenreContext');

function generateYearsWindow(totalYears = 120) {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let year = currentYear; year >= currentYear - totalYears; year--) {
    years.push(String(year));
  }
  return years;
}

function collectContextRequirements(children) {
  const requirements = new Set();
  for (const child of children) {
    const childRequirements = getContextRequirementsForCatalog(child);
    childRequirements.forEach((requirement) => requirements.add(requirement));
  }
  return requirements;
}

function parseAvailableSeasons(payload) {
  if (!Array.isArray(payload)) return [];
  const seasonOptions = [];
  for (const yearData of payload) {
    const year = yearData?.year;
    const seasons = Array.isArray(yearData?.seasons) ? yearData.seasons : [];
    for (const season of seasons) {
      if (typeof season !== 'string' || !season.trim()) continue;
      const formattedSeason = `${season.charAt(0).toUpperCase()}${season.slice(1)}`;
      seasonOptions.push(`${formattedSeason} ${year}`);
    }
  }
  return seasonOptions;
}

async function safeResolve(promiseFactory, fallbackValue, label) {
  try {
    return await promiseFactory();
  } catch (error) {
    logger.warn(`[MergedGenreContext] ${label} failed: ${error?.message || error}`);
    return fallbackValue;
  }
}

async function buildMergedGenreRoutingContext(childCatalogs = [], config = {}, language = 'en-US') {
  const children = Array.isArray(childCatalogs) ? childCatalogs.filter(Boolean) : [];

  const context = {
    years: [],
    genres_movie_names: [],
    genres_series_names: [],
    genres_tvdb_all_names: [],
    tmdbMovieGenres: [],
    tmdbSeriesGenres: [],
    tvdbGenres: [],
    animeGenreNames: [],
    malGenres: [],
    studioNames: [],
    filterLanguages: [],
    availableSeasons: [],
    traktMovieGenreNames: [],
    traktShowGenreNames: [],
    mdblistStandardGenreNames: [],
    mdblistAnimeGenreNames: [],
  };

  if (children.length === 0) {
    return context;
  }

  const requirements = collectContextRequirements(children);
  const tasks = [];

  if (requirements.has('years')) {
    context.years = generateYearsWindow();
  }

  if (requirements.has('tmdbGenres')) {
    tasks.push(
      safeResolve(
        async () => {
          const [movieGenres, seriesGenres] = await Promise.all([
            getGenreList('tmdb', language, 'movie', config),
            getGenreList('tmdb', language, 'series', config),
          ]);
          context.tmdbMovieGenres = Array.isArray(movieGenres) ? movieGenres.filter(Boolean) : [];
          context.tmdbSeriesGenres = Array.isArray(seriesGenres) ? seriesGenres.filter(Boolean) : [];
          context.genres_movie_names = Array.isArray(movieGenres) ? movieGenres.map(g => g?.name).filter(Boolean).sort() : [];
          context.genres_series_names = Array.isArray(seriesGenres) ? seriesGenres.map(g => g?.name).filter(Boolean).sort() : [];
        },
        undefined,
        'TMDB genre prefetch'
      )
    );
  }

  if (requirements.has('tvdbGenres')) {
    tasks.push(
      safeResolve(
        async () => {
          const tvdbGenres = await getGenreList('tvdb', language, 'series', config);
          context.tvdbGenres = Array.isArray(tvdbGenres) ? tvdbGenres.filter(Boolean) : [];
          context.genres_tvdb_all_names = Array.isArray(tvdbGenres)
            ? tvdbGenres.map(g => g?.name).filter(Boolean).sort()
            : [];
        },
        undefined,
        'TVDB genre prefetch'
      )
    );
  }

  if (requirements.has('languages')) {
    tasks.push(
      safeResolve(
        async () => {
          const languages = await getLanguages(config);
          context.filterLanguages = Array.isArray(languages)
            ? languages.map((lang) => lang?.name).filter(Boolean)
            : [];
        },
        undefined,
        'language prefetch'
      )
    );
  }

  if (requirements.has('malGenres')) {
    tasks.push(
      safeResolve(
        async () => {
          const animeGenres = await cacheWrapJikanApi('anime-genres', async () => jikan.getAnimeGenres(), null, { skipVersion: true });
          context.malGenres = Array.isArray(animeGenres) ? animeGenres.filter(Boolean) : [];
          context.animeGenreNames = Array.isArray(animeGenres)
            ? animeGenres.map((genre) => genre?.name).filter(Boolean).sort()
            : [];
        },
        undefined,
        'MAL genre prefetch'
      )
    );
  }

  if (requirements.has('malStudios')) {
    tasks.push(
      safeResolve(
        async () => {
          const studios = await cacheWrapJikanApi('mal-studios', async () => jikan.getStudios(), 30 * 24 * 60 * 60, { skipVersion: true });
          context.studioNames = Array.isArray(studios)
            ? studios.map((studio) => {
              const defaultTitle = Array.isArray(studio?.titles)
                ? studio.titles.find((title) => title?.type === 'Default')
                : null;
              return defaultTitle?.title || null;
            }).filter(Boolean).sort()
            : [];
        },
        undefined,
        'MAL studio prefetch'
      )
    );
  }

  if (requirements.has('malSeasons')) {
    tasks.push(
      safeResolve(
        async () => {
          const seasonPayload = await cacheWrapJikanApi('mal-seasons', async () => jikan.getAvailableSeasons(), 24 * 60 * 60, { skipVersion: true });
          context.availableSeasons = parseAvailableSeasons(seasonPayload);
        },
        undefined,
        'MAL seasons prefetch'
      )
    );
  }

  if (requirements.has('traktGenres')) {
    tasks.push(
      safeResolve(
        async () => {
          const [movieGenres, showGenres] = await Promise.all([
            fetchTraktGenres('movies'),
            fetchTraktGenres('shows'),
          ]);
          context.traktMovieGenreNames = Array.isArray(movieGenres) ? movieGenres.map((genre) => genre?.name).filter(Boolean).sort() : [];
          context.traktShowGenreNames = Array.isArray(showGenres) ? showGenres.map((genre) => genre?.name).filter(Boolean).sort() : [];
        },
        undefined,
        'Trakt genre prefetch'
      )
    );
  }

  if (requirements.has('mdblistGenres')) {
    const { needsStandard, needsAnime } = getMdbListSelectionNeeds(children);
    const mdblistKey = config?.apiKeys?.mdblist || process.env.MDBLIST_API_KEY || '';
    if (mdblistKey && (needsStandard || needsAnime)) {
      if (needsStandard) {
        tasks.push(
          safeResolve(
            async () => {
              context.mdblistStandardGenreNames = await fetchMDBListGenres(mdblistKey, false);
            },
            undefined,
            'MDBList standard genres prefetch'
          )
        );
      }
      if (needsAnime) {
        tasks.push(
          safeResolve(
            async () => {
              context.mdblistAnimeGenreNames = await fetchMDBListGenres(mdblistKey, true);
            },
            undefined,
            'MDBList anime genres prefetch'
          )
        );
      }
    }
  }

  await Promise.all(tasks);
  return context;
}

module.exports = {
  buildMergedGenreRoutingContext,
  generateYearsWindow,
};
