require("dotenv").config();
import { getGenreList } from "./getGenreList";
import { getLanguages } from "./getLanguages";
import { fetchMDBListGenres } from "../utils/mdbList";
import { getGenresFromStremThruCatalog, fetchStremThruCatalog } from "../utils/stremthru";
import { fetchTraktGenres } from "../utils/traktUtils";
import { getGenresBySelection } from "../static/genres";
import buildInfo from "./buildInfo";
import catalogsTranslations from "../static/translations.json";
import CATALOG_TYPES from "../static/catalog-types.json";
const jikan: any = require('./mal');
const DEFAULT_LANGUAGE = "en-US";
import { cacheWrapJikanApi, cacheWrapGlobal, cacheWrapStremThruGenres } from './getCache';
import consola from 'consola';
const logger = consola.withTag('Manifest');


const host = process.env.HOST_NAME && process.env.HOST_NAME.startsWith('http')
  ? process.env.HOST_NAME
  : `https://${process.env.HOST_NAME}`;

const manifestLogoUrl = process.env.ADDON_LOGO_URL && process.env.ADDON_LOGO_URL.trim() !== ''
  ? process.env.ADDON_LOGO_URL.trim()
  : `${host}/logo.png`;

const MANIFEST_CACHE_TTL = 5 * 60;

function generateArrayOfYears(maxYears: number): string[] {
  const max = new Date().getFullYear();
  const min = max - maxYears;
  const years: string[] = [];
  for (let i = max; i >= min; i--) {
    years.push(i.toString());
  }
  return years;
}

function setOrderLanguage(language: string, languagesArray: any[]): string[] {
  const languageObj = languagesArray.find((lang: any) => lang.iso_639_1 === language);
  const fromIndex = languagesArray.indexOf(languageObj);
  const element = languagesArray.splice(fromIndex, 1)[0];
  languagesArray = languagesArray.sort((a: any, b: any) => (a.name > b.name ? 1 : -1));
  languagesArray.splice(0, 0, element);
  return [...new Set(languagesArray.map((el: any) => el.name))];
}

function loadTranslations(language: string): Record<string, string> {
  const defaultTranslations = catalogsTranslations[DEFAULT_LANGUAGE] || {};
  const selectedTranslations = catalogsTranslations[language] || {};

  return { ...defaultTranslations, ...selectedTranslations };
}

function createCatalog(id: string, type: string, catalogDef: any, options: string[], showPrefix: boolean, translatedCatalogs: Record<string, string>, showInHome: boolean = false, customName: string | null = null, displayType: string | null = null, prefixName: string = "AIOMetadata"): any {
  const extra: any[] = [];

  if (catalogDef.extraSupported.includes("genre")) {
    if (catalogDef.defaultOptions) {
      const formattedOptions = catalogDef.defaultOptions.map((option: string) => {
        if (option.includes('.')) {
          const [field, order] = option.split('.');
          if (translatedCatalogs[field] && translatedCatalogs[order]) {
            return `${translatedCatalogs[field]} (${translatedCatalogs[order]})`;
          }
          return option;
        }
        return translatedCatalogs[option] || option;
      });
      const finalOptions = (id.startsWith('tmdb.airing_today') && !showInHome) ? ['None', ...formattedOptions] : formattedOptions;
      const genreExtra: any = {
        name: "genre",
        options: finalOptions,
        isRequired: showInHome ? false : true
      };

      if (options && options.length > 0) {
        genreExtra.default = options[0];
      }

      extra.push(genreExtra);
    } else {
      const genreExtra: any = {
        name: "genre",
        options,
        isRequired: showInHome ? false : true
      };

      if (options && options.length > 0) {
        genreExtra.default = options[0];
      }

      extra.push(genreExtra);
    }
  }
  if (catalogDef.extraSupported.includes("search")) {
    extra.push({ name: "search" });
  }
  if (catalogDef.extraSupported.includes("skip")) {
    extra.push({ name: "skip" });
  }

  let pageSize: number;
  if (id.startsWith('mal.')) {
    pageSize = 25;
  } else {
    pageSize = parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20;
  }

  const defaultEnglishTranslations = catalogsTranslations[DEFAULT_LANGUAGE] || {};
  const defaultEnglishName = defaultEnglishTranslations[catalogDef.nameKey];

  const isDefaultEnglishName = customName && customName === defaultEnglishName;

  const hasCustomName = customName && typeof customName === 'string' && customName.trim() !== '' && !isDefaultEnglishName;
  const baseName = hasCustomName ? customName : translatedCatalogs[catalogDef.nameKey];
  const catalogName = `${showPrefix ? `${prefixName} - ` : ""}${baseName}`;

  const catalogType = displayType || type;
  let finalId = id;
  if (displayType) {
    finalId = `${id}_${type}`;
  }

  return {
    id: finalId,
    type: catalogType,
    name: catalogName,
    pageSize: pageSize,
    extra,
    showInHome: showInHome
  };
}

function getCatalogDefinition(catalogId: string): any {
  const [provider, catalogType] = catalogId.split('.');

  if ((catalogType === 'favorites' || catalogType === 'watchlist') && CATALOG_TYPES.auth && CATALOG_TYPES.auth[catalogType]) {
    return CATALOG_TYPES.auth[catalogType];
  }

  if (CATALOG_TYPES[provider] && CATALOG_TYPES[provider][catalogType]) {
    return CATALOG_TYPES[provider][catalogType];
  }
  if (CATALOG_TYPES.default && CATALOG_TYPES.default[catalogType]) {
    return CATALOG_TYPES.default[catalogType];
  }
  return null;
}

function getOptionsForCatalog(catalogDef: any, type: string, showInHome: boolean, { years, genres_movie, genres_series, filterLanguages }: { years: string[]; genres_movie: string[]; genres_series: string[]; filterLanguages: string[] }): string[] {
  if (catalogDef.defaultOptions) return catalogDef.defaultOptions;

  const movieGenres = [...genres_movie]
  const seriesGenres = [...genres_series]

  switch (catalogDef.nameKey) {
    case 'year':
      return years;
    case 'language':
      return filterLanguages;
    case 'popular':
      return type === 'movie' ? movieGenres : seriesGenres;
    default:
      if (type === 'anime') {
        return [];
      }
      return type === 'movie' ? movieGenres : seriesGenres;
  }
}

async function createMDBListCatalog(userCatalog: any, mdblistKey: string, prefetchedStandardGenres: string[] = [], prefetchedAnimeGenres: string[] = [], showPrefix: boolean = false, prefixName: string = "AIOMetadata"): Promise<any> {
  try {
    logger.debug(`Creating MDBList catalog: ${userCatalog.id} (${userCatalog.type})`);
    const listId = userCatalog.id.split(".")[1];
    logger.debug(`MDBList list ID: ${listId}, API key present: ${!!mdblistKey}`);

    const genreSelection = userCatalog.genreSelection || 'standard';
    let genres: string[] = [];

    if (genreSelection === 'standard' && prefetchedStandardGenres.length > 0) {
      genres = prefetchedStandardGenres;
      logger.debug(`MDBList using ${genres.length} pre-fetched standard genres`);
    } else if (genreSelection === 'anime' && prefetchedAnimeGenres.length > 0) {
      genres = prefetchedAnimeGenres;
      logger.debug(`MDBList using ${genres.length} pre-fetched anime genres`);
    } else if (genreSelection === 'all' && (prefetchedStandardGenres.length > 0 || prefetchedAnimeGenres.length > 0)) {
      genres = [...prefetchedStandardGenres, ...prefetchedAnimeGenres];
      logger.debug(`MDBList using ${genres.length} pre-fetched combined genres`);
    } else {
      genres = getGenresBySelection(genreSelection);
      logger.info(`MDBList using ${genres.length} static fallback genres for selection: ${genreSelection}`);
    }

    const genreOptions = userCatalog.showInHome ? genres : ['None', ...genres];

    const catalogType = userCatalog.displayType || userCatalog.type;

    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: `${showPrefix ? `${prefixName} - ` : ""}${userCatalog.name}`,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };

    logger.debug(`MDBList catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error: any) {
    logger.error(`Error creating MDBList catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

async function createTraktCatalog(userCatalog: any, prefetchedMovieGenres: any[] = [], prefetchedShowGenres: any[] = [], showPrefix: boolean = false, prefixName: string = "AIOMetadata"): Promise<any> {
  try {
    logger.debug(`Creating Trakt catalog: ${userCatalog.id} (${userCatalog.type})`);

    let genres: any[] = [];
    if (userCatalog.type === 'movie' && prefetchedMovieGenres.length > 0) {
      genres = prefetchedMovieGenres;
      logger.debug(`Trakt using ${genres.length} pre-fetched movie genres`);
    } else if (userCatalog.type === 'series' && prefetchedShowGenres.length > 0) {
      genres = prefetchedShowGenres;
      logger.debug(`Trakt using ${genres.length} pre-fetched show genres`);
    } else if (userCatalog.type === 'all') {
      const combined = [...prefetchedMovieGenres, ...prefetchedShowGenres];
      const uniqueMap = new Map(combined.map((g: any) => [g.slug, g]));
      genres = Array.from(uniqueMap.values()).sort((a: any, b: any) => a.name.localeCompare(b.name));

      logger.debug(`Trakt using ${genres.length} combined genres`);
    } else {
      logger.warn(`Trakt no pre-fetched genres available for type: ${userCatalog.type}`);
    }

    const genreNames = genres.map((g: any) => g.name);

    const genreOptions = userCatalog.showInHome ? genreNames : ['None', ...genreNames];

    const catalogType = userCatalog.displayType || userCatalog.type;

    const catalog: any = {
      id: userCatalog.id,
      type: catalogType,
      name: `${showPrefix ? `${prefixName} - ` : ""}${userCatalog.name}`,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20,
      extra: [
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };

    if (genreOptions.length > 0) {
      catalog.extra.unshift({
        name: "genre",
        options: genreOptions,
        isRequired: userCatalog.showInHome ? false : true
      });
    }

    logger.debug(`Trakt catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error: any) {
    logger.error(`Error creating Trakt catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

async function createTMDBListCatalog(userCatalog: any, movieGenres: string[] = [], seriesGenres: string[] = [], showPrefix: boolean = false, prefixName: string = "AIOMetadata"): Promise<any> {
  try {
    logger.debug(`Creating TMDB List catalog: ${userCatalog.id} (${userCatalog.type})`);

    const catalogType = userCatalog.displayType || userCatalog.type;

    let genres: string[] = [];
    if (userCatalog.type === 'movie' && movieGenres.length > 0) {
      genres = movieGenres;
      logger.debug(`TMDB List using ${genres.length} movie genres`);
    } else if (userCatalog.type === 'series' && seriesGenres.length > 0) {
      genres = seriesGenres;
      logger.debug(`TMDB List using ${genres.length} series genres`);
    } else if (userCatalog.type === 'all') {
      const combined = [...movieGenres, ...seriesGenres];
      const uniqueGenres = [...new Set(combined)].sort();
      genres = uniqueGenres;
      logger.debug(`TMDB List using ${genres.length} combined genres`);
    }

    const genreOptions = genres.length > 0
      ? (userCatalog.showInHome ? genres : ['None', ...genres])
      : ['None'];

    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: `${showPrefix ? `${prefixName} - ` : ""}${userCatalog.name}`,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };

    logger.debug(`TMDB List catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error: any) {
    logger.error(`Error creating TMDB List catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

function createTMDBDiscoverCatalog(userCatalog: any, movieGenres: string[] = [], seriesGenres: string[] = [], showPrefix: boolean = false, prefixName: string = "AIOMetadata"): any {
  try {
    logger.debug(`Creating TMDB Discover catalog: ${userCatalog.id} (${userCatalog.type})`);
    let genres: string[] = ['None'];
    if (userCatalog.type === 'movie' && movieGenres.length > 0) {
      genres = movieGenres;
      logger.debug(`TMDB List using ${genres.length} movie genres`);
    } else if (userCatalog.type === 'series' && seriesGenres.length > 0) {
      genres = seriesGenres;
      logger.debug(`TMDB List using ${genres.length} series genres`);
    }

    const catalogType = userCatalog.displayType || userCatalog.type;
    const genreOptions = genres.length > 0
    ? (userCatalog.showInHome ? genres : ['None', ...genres])
    : ['None'];
    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: `${showPrefix ? `${prefixName} - ` : ""}${userCatalog.name}`,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };

    logger.debug(`TMDB Discover catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error: any) {
    logger.error(`Error creating TMDB Discover catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

function createTVDBDiscoverCatalog(userCatalog: any, genres: string[] = [], showPrefix: boolean = false, prefixName: string = "AIOMetadata"): any {
  try {
    logger.debug(`Creating TVDB Discover catalog: ${userCatalog.id} (${userCatalog.type})`);

    const catalogType = userCatalog.displayType || userCatalog.type;
    const genreOptions = genres.length > 0
    ? (userCatalog.showInHome ? genres : ['None', ...genres])
    : ['None'];
    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: `${showPrefix ? `${prefixName} - ` : ""}${userCatalog.name}`,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };

    logger.debug(`TVDB Discover catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error: any) {
    logger.error(`Error creating TVDB Discover catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

async function createLetterboxdCatalog(userCatalog: any, showPrefix: boolean = false, prefixName: string = "AIOMetadata"): Promise<any> {
  try {
    logger.debug(`Creating Letterboxd catalog: ${userCatalog.id} (${userCatalog.type})`);

    const catalogType = userCatalog.displayType || userCatalog.type;
    const genreNameById: Record<string, string> = {
      "8G":  "Action",
      "9k":  "Adventure",
      "8m":  "Animation",
      "7I":  "Comedy",
      "9Y":  "Crime",
      "ai":  "Documentary",
      "7S":  "Drama",
      "8w":  "Family",
      "82":  "Fantasy",
      "90":  "History",
      "aC":  "Horror",
      "b6":  "Music",
      "aW":  "Mystery",
      "8c":  "Romance",
      "9a":  "Science Fiction",
      "a8":  "Thriller",
      "1hO": "TV Movie",
      "9u":  "War",
      "8Q":  "Western",
    };
    let genreOptions = Object.values(genreNameById).sort((a, b) => a.localeCompare(b));
    genreOptions = userCatalog.showInHome ? genreOptions : ['None', ...genreOptions];
    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: `${showPrefix ? `${prefixName} - ` : ""}${userCatalog.name}`,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };

    logger.debug(`Letterboxd catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error: any) {
    logger.error(`Error creating Letterboxd catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

async function createStremThruCatalog(userCatalog: any, showPrefix: boolean = false, prefixName: string = "AIOMetadata"): Promise<any> {
  try {
    const parts = userCatalog.id.split(".");
    if (parts.length < 3) {
      logger.warn(`Invalid StremThru catalog ID format: ${userCatalog.id}`);
      return null;
    }

    logger.debug(`Creating StremThru catalog: ${userCatalog.id}`);

    const manifestId = parts[1];
    const catalogId = parts[2];

    const catalogUrl = userCatalog.sourceUrl || userCatalog.source;
    if (!catalogUrl) {
      logger.warn(`No source URL found for catalog: ${userCatalog.id}`);
      return null;
    }

    let genres: string[] = [];

    if (userCatalog.genres && Array.isArray(userCatalog.genres) && userCatalog.genres.length > 0) {
      genres = userCatalog.genres;
    } else if (userCatalog.manifestData && userCatalog.manifestData.extra) {
      const genreExtra = userCatalog.manifestData.extra.find((e: any) => e.name === 'genre');
      if (genreExtra && genreExtra.options && Array.isArray(genreExtra.options) && genreExtra.options.length > 0) {
        genres = genreExtra.options;
      }
    }

    if (genres.length === 0) {
      try {
        logger.debug(`Attempting to fetch genres from catalog items for ${userCatalog.id}`);
        genres = await cacheWrapStremThruGenres(catalogUrl, async () => {
          logger.debug(`Fetching fresh genres from StremThru catalog: ${catalogUrl}`);
          const items = await fetchStremThruCatalog(catalogUrl);
          if (items && items.length > 0) {
            const extractedGenres = await getGenresFromStremThruCatalog(items);
            logger.debug(`Extracted and cached ${extractedGenres.length} genres from catalog items`);
            return extractedGenres;
          }
          return [];
        });
        logger.debug(`Using ${genres.length} genres for ${userCatalog.id}`);
      } catch (genreError: any) {
        logger.warn(`Failed to fetch genres from catalog items for ${userCatalog.id}:`, genreError.message);
      }
    }

    if (genres.length === 0) {
      logger.warn(`No genres found for ${userCatalog.id}, using fallback`);
      genres = ['None'];
    }

    const genreOptions = userCatalog.showInHome ? genres : ['None', ...genres];

    const catalogType = userCatalog.displayType || userCatalog.type;

    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: `${showPrefix ? `${prefixName} - ` : ""}${userCatalog.name}`,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };

    logger.debug(`StremThru catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error: any) {
    logger.error(`Error creating StremThru catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

function createAniListCatalog(userCatalog: any, showPrefix: boolean = false, prefixName: string = "AIOMetadata"): any {
  try {
    logger.debug(`Creating AniList catalog: ${userCatalog.id} (${userCatalog.type})`);
    const catalogType = userCatalog.displayType || userCatalog.type || 'series';

    const anilistGenres = [
      'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy',
      'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological',
      'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'
    ];

    let genreOptions: string[];
    if (userCatalog.id === 'anilist.trending' || userCatalog.id.startsWith('anilist.discover')) {
      genreOptions = userCatalog.showInHome ? anilistGenres : ['None', ...anilistGenres];
    } else {
      genreOptions = ['None'];
    }

    const catalog = {
      id: userCatalog.id,
      type: catalogType,
      name: `${showPrefix ? `${prefixName} - ` : ""}${userCatalog.name}`,
      pageSize: userCatalog.id === 'anilist.trending' ? 50 : (parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20),
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };

    logger.debug(`AniList catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error: any) {
    logger.error(`Error creating AniList catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

async function createMalCatalog(userCatalog: any, genres: string[], showPrefix: boolean = false, prefixName: string = "AIOMetadata"): Promise<any> {
  try {
    logger.debug(`Creating MAL discover catalog: ${userCatalog.id} (${userCatalog.type})`);


    const genreOptions = genres.length > 0
    ? (userCatalog.showInHome ? genres : ['None', ...genres])
    : ['None'];
    const catalog: any = {
      id: userCatalog.id,
      type: 'anime',
      name: showPrefix ? `${userCatalog.name}` : userCatalog.name,
      extra: [
        { name: "genre", options: genreOptions, isRequired: userCatalog.showInHome ? false : true },
        { name: 'skip' }
      ],
      showInHome: userCatalog.showInHome
    };

    if (!userCatalog.showInHome) {
      catalog.extra.unshift({
        name: "genre",
        options: ["None"],
        isRequired: true,
        default: "None"
      });
    }

    logger.debug(`MAL discover catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error: any) {
    logger.error(`Error creating Creating MAL discover catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

function createPublicMetaDBCatalog(userCatalog: any, showPrefix: boolean = false, prefixName: string = "AIOMetadata"): any {
  try {
    const catalogType = userCatalog.displayType || userCatalog.type;
    const catalogName = userCatalog.name || 'PublicMetaDB';
    const extra: any[] = [{ name: "skip" }];
    if (!userCatalog.showInHome) {
      extra.unshift({ name: "genre", options: ["None"], isRequired: true });
    }
    return {
      id: userCatalog.id,
      type: catalogType,
      name: `${showPrefix ? `${prefixName} - ` : ""}${catalogName}`,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20,
      extra,
      showInHome: userCatalog.showInHome ?? false
    };
  } catch (error: any) {
    logger.error(`Error creating PublicMetaDB catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

async function createSimklCatalog(userCatalog: any, showPrefix: boolean = false, prefixName: string = "AIOMetadata"): Promise<any> {
  try {
    logger.debug(`Creating Simkl catalog: ${userCatalog.id} (${userCatalog.type})`);

    const SIMKL_MOVIE_GENRE_OPTIONS = [
      'all', 'action', 'adventure', 'animation', 'comedy', 'crime', 'documentary', 'drama', 'family',
      'fantasy', 'history', 'horror', 'music', 'mystery', 'romance', 'science-fiction', 'thriller',
      'tv-movie', 'war', 'western'
    ];

    const SIMKL_TV_GENRE_OPTIONS = [
      'all', 'action', 'adventure', 'animation', 'awards-show', 'children', 'comedy', 'crime',
      'documentary', 'drama', 'family', 'fantasy', 'food', 'game-show', 'history', 'home-and-garden',
      'horror', 'indie', 'korean-drama', 'martial-arts', 'mini-series', 'musical', 'mystery', 'news',
      'podcast', 'reality', 'romance', 'science-fiction', 'soap', 'special-interest', 'sport', 'suspense',
      'talk-show', 'thriller', 'travel', 'video-game-play', 'war', 'western'
    ];

    const SIMKL_ANIME_GENRE_OPTIONS = [
      'all', 'action', 'adventure', 'comedy', 'drama', 'ecchi', 'educational', 'fantasy', 'gag-humor',
      'gore', 'harem', 'historical', 'horror', 'idol', 'isekai', 'josei', 'kids', 'magic',
      'martial-arts', 'mecha', 'military', 'music', 'mystery', 'mythology', 'parody', 'psychological',
      'racing', 'reincarnation', 'romance', 'samurai', 'school', 'sci-fi', 'seinen', 'shoujo',
      'shoujo-ai', 'shounen', 'shounen-ai', 'slice-of-life', 'space', 'sports', 'strategy-game',
      'super-power', 'supernatural', 'thriller', 'vampire', 'yaoi', 'yuri'
    ];

    const SOURCE_LABELS: Record<string, string[]> = {
      movie: SIMKL_MOVIE_GENRE_OPTIONS,
      series: SIMKL_TV_GENRE_OPTIONS,
      anime: SIMKL_ANIME_GENRE_OPTIONS
    };

    const catalogType = userCatalog.displayType || userCatalog.type;

    const catalog: any = {
      id: userCatalog.id,
      type: catalogType,
      name: `${showPrefix ? `${prefixName} - ` : ""}${userCatalog.name}`,
      pageSize: parseInt(process.env.CATALOG_LIST_ITEMS_SIZE as string) || 20,
      extra: [
        { name: "genre", options: SOURCE_LABELS[userCatalog.type], isRequired: userCatalog.showInHome ? false : true },
        { name: "skip" },
      ],
      showInHome: userCatalog.showInHome
    };

    if (userCatalog.id.startsWith('simkl.trending.')) {
      const intervalOptions = userCatalog.showInHome ? ['today', 'week', 'month'] : ['None', 'today', 'week', 'month'];
      const defaultInterval = userCatalog.metadata?.interval || 'today';

      catalog.extra.unshift({
        name: "genre",
        options: intervalOptions,
        isRequired: !userCatalog.showInHome,
        default: userCatalog.showInHome ? defaultInterval : 'None'
      });
    } else if (!userCatalog.showInHome) {
      catalog.extra.unshift({
        name: "genre",
        options: ["None"],
        isRequired: true,
        default: "None"
      });
    }

    logger.debug(`Simkl catalog created successfully: ${catalog.id}`);
    return catalog;
  } catch (error: any) {
    logger.error(`Error creating Simkl catalog ${userCatalog.id}:`, error.message);
    return null;
  }
}

async function getManifest(config: any): Promise<any> {
  const startTime = Date.now();
  logger.start('Starting manifest generation...');

    const language = config.language || DEFAULT_LANGUAGE;
    const showPrefix = config.showPrefix === true;
    const prefixName = config.addonName || "AIOMetadata";
    const provideImdbId = config.provideImdbId === "true";
    const sessionId = config.sessionId;
    const userCatalogs = config.catalogs || getDefaultCatalogs();
    const translatedCatalogs = loadTranslations(language);


  const enabledCatalogs = userCatalogs.filter((c: any) => c.enabled);
  logger.info(`Total catalogs: ${userCatalogs.length}, Enabled: ${enabledCatalogs.length}`);
  logger.debug(`MDBList catalogs in enabled:`, enabledCatalogs.filter((c: any) => c.id.startsWith('mdblist.')).map((c: any) => c.id));
  logger.debug(`Custom catalogs in enabled:`, enabledCatalogs.filter((c: any) => c.id.startsWith('custom.')).map((c: any) => c.id));

  const years = generateArrayOfYears(new Date().getFullYear() - 1900);

  const hasTmdbCatalogs = enabledCatalogs.some((cat: any) => cat.id.startsWith('tmdb.'));
  const hasTvdbCatalogs = enabledCatalogs.some((cat: any) => cat.id.startsWith('tvdb.'));
  const hasMalCatalogs = enabledCatalogs.some((cat: any) => cat.id.startsWith('mal.'));

  const fetchPromises: Promise<any>[] = [];

  if (hasTmdbCatalogs) {
    fetchPromises.push(
      getGenreList('tmdb', language, "movie", config),
      getGenreList('tmdb', language, "series", config)
    );
  }

  if (hasTvdbCatalogs) {
    fetchPromises.push(
      getGenreList('tvdb', language, "series", config)
    );
  }

  fetchPromises.push(
    cacheWrapGlobal(`languages:${language}`, () => getLanguages(config), 60 * 60)
  );

  const genreStart = Date.now();
  const results = await Promise.all(fetchPromises);
  logger.debug(`Genre lists and languages fetched in ${Date.now() - genreStart}ms`);

  let genres_movie: any[] = [], genres_series: any[] = [], genres_tvdb_all: any[] = [];
  let resultIndex = 0;

  if (hasTmdbCatalogs) {
    genres_movie = results[resultIndex++];
    genres_series = results[resultIndex++];
  }

  if (hasTvdbCatalogs) {
    genres_tvdb_all = results[resultIndex++];
  }

  const languagesArray = results[resultIndex];

  let animeGenreNames: string[] = [];
  let studioNames: string[] = [];
  if (hasMalCatalogs) {
    const animeStart = Date.now();
    const animeGenres = await cacheWrapJikanApi('anime-genres', async () => {
      logger.info('[Cache Miss] Fetching fresh anime genre list in manifest from Jikan...');
      return await jikan.getAnimeGenres();
    }, null, { skipVersion: true });
    animeGenreNames = animeGenres.filter(Boolean).map((genre: any) => genre.name).sort();
    logger.debug(`Anime genres fetched in ${Date.now() - animeStart}ms`);

    const hasStudioCatalog = enabledCatalogs.some((cat: any) => cat.id === 'mal.studios');
    if (hasStudioCatalog) {
      try {
        const studioPromise = cacheWrapJikanApi('mal-studios', async () => {
          logger.debug('[Cache Miss] Fetching fresh anime studio list in manifest from Jikan...');
          return await jikan.getStudios();
        }, 30 * 24 * 60 * 60, { skipVersion: true });

        const timeoutPromise = new Promise((_: any, reject: any) => {
          setTimeout(() => reject(new Error('Studio fetch timeout')), 2000);
        });

        const studios: any = await Promise.race([studioPromise, timeoutPromise]);

        studioNames = studios.map((studio: any) => {
          const defaultTitle = studio.titles.find((t: any) => t.type === 'Default');
          return defaultTitle ? defaultTitle.title : null;
        }).filter(Boolean);
        logger.success(`Studio list fetched successfully (${studioNames.length} studios)`);
      } catch (error: any) {
        logger.warn('Studio list fetch failed, using empty list:', error.message);
        studioNames = [];
      }
    }

    const hasSeasonsCatalog = enabledCatalogs.some((cat: any) => cat.id === 'mal.seasons');
    if (hasSeasonsCatalog) {
      try {
        const seasonsData = await cacheWrapJikanApi('mal-available-seasons', async () => {
          logger.debug('[Cache Miss] Fetching available seasons from Jikan...');
          return await jikan.getAvailableSeasons();
        }, 7 * 24 * 60 * 60, { skipVersion: true });

        const seasonNames = ['Winter', 'Spring', 'Summer', 'Fall'];
        const seasonOrder: Record<string, number> = { winter: 0, spring: 1, summer: 2, fall: 3 };
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth();
        const currentSeasonIndex =
          currentMonth <= 2 ? 0 : currentMonth <= 5 ? 1 : currentMonth <= 8 ? 2 : 3;
        const currentRank = currentYear * 4 + currentSeasonIndex;

        const entries: { year: number; idx: number; rank: number }[] = [];
        for (const yearData of seasonsData) {
          for (const season of yearData.seasons || []) {
            const idx = seasonOrder[season.toLowerCase()];
            if (idx === undefined) continue;
            entries.push({ year: yearData.year, idx, rank: yearData.year * 4 + idx });
          }
        }

        const pastOrCurrent = entries
          .filter(e => e.rank <= currentRank)
          .sort((a, b) => b.rank - a.rank);
        const future = entries
          .filter(e => e.rank > currentRank)
          .sort((a, b) => a.rank - b.rank);

        const seasonOptions = [...pastOrCurrent, ...future].map(
          e => `${seasonNames[e.idx]} ${e.year}`
        );

        (global as any).availableSeasons = seasonOptions;
        logger.debug(`Available seasons fetched successfully (${seasonOptions.length} seasons)`);
      } catch (error: any) {
        logger.warn('Available seasons fetch failed, will use fallback:', error.message);
        (global as any).availableSeasons = null;
      }
    }
  }

  const genres_movie_names = genres_movie.map((g: any) => g.name).sort();
  const genres_series_names = genres_series.map((g: any) => g.name).sort();
  const genres_tvdb_all_names = genres_tvdb_all.map((g: any) => g.name).sort();
  const filterLanguages = setOrderLanguage(language, languagesArray);
  const isMDBList = (id: string) => id.startsWith("mdblist.");
  const isTrakt = (id: string) => id.startsWith("trakt.");
  const isSimkl = (id: string) => id.startsWith("simkl.");
  const isPublicMetaDB = (id: string) => id.startsWith("publicmetadb.");
  const options = { years, genres_movie: genres_movie_names, genres_series: genres_series_names, filterLanguages };

  let mdblistGenresStandard: string[] = [];
  let mdblistGenresAnime: string[] = [];
  if (enabledCatalogs.some((c: any) => c.id.startsWith('mdblist.'))) {
    logger.debug('Pre-fetching MDBList genres for all catalogs...');
    try {
      [mdblistGenresStandard, mdblistGenresAnime] = await Promise.all([
        fetchMDBListGenres(config.apiKeys?.mdblist, false),
        fetchMDBListGenres(config.apiKeys?.mdblist, true)
      ]);
      logger.success(`Pre-fetched ${mdblistGenresStandard.length} standard genres and ${mdblistGenresAnime.length} anime genres`);
    } catch (error: any) {
      logger.warn('Failed to pre-fetch MDBList genres, will use fallback:', error.message);
    }
  }

  let traktGenresMovies: any[] = [];
  let traktGenresShows: any[] = [];
  if (enabledCatalogs.some((c: any) => c.id.startsWith('trakt.'))) {
    logger.debug('Pre-fetching Trakt genres for all catalogs...');
    try {
      [traktGenresMovies, traktGenresShows] = await Promise.all([
        fetchTraktGenres('movies'),
        fetchTraktGenres('shows')
      ]);
      logger.success(`Pre-fetched ${traktGenresMovies.length} movie genres and ${traktGenresShows.length} show genres from Trakt`);
    } catch (error: any) {
      logger.warn('Failed to pre-fetch Trakt genres, catalogs will have no genres:', error.message);
    }
  }

  let catalogs: any[] = await Promise.all(enabledCatalogs
    .filter((userCatalog: any) => {
      const catalogDef = getCatalogDefinition(userCatalog.id);
      if (isMDBList(userCatalog.id)) {
        return true;
      }
      if (isTrakt(userCatalog.id)) {
        return true;
      }
      if (isSimkl(userCatalog.id)) {
        return true;
      }
      if (userCatalog.id.startsWith('tmdb.list.')) {
        return true;
      }
      if (userCatalog.id.startsWith('tmdb.discover.')) {
        return true;
      }
      if (userCatalog.id.startsWith('tvdb.discover.')) {
        return true;
      }
      if (userCatalog.id.startsWith('mal.discover.')) {
        return true;
      }
      if (userCatalog.id.startsWith('stremthru.')) {
        return true;
      }
      if (userCatalog.id.startsWith('custom.')) {
        return true;
      }
      if (userCatalog.id.startsWith('anilist.')) {
        return true;
      }
      if (userCatalog.id.startsWith('letterboxd.')) {
        return true;
      }
      if (userCatalog.id.startsWith('flixpatrol.')) {
        return true;
      }
      if (isPublicMetaDB(userCatalog.id)) {
        return true;
      }
      if (!catalogDef) {
        logger.debug(`Catalog ${userCatalog.id} failed filter: no catalog definition`);
        return false;
      }
      return true;
    })
    .map(async (userCatalog: any) => {
      if (isMDBList(userCatalog.id)) {
          logger.debug(`Processing MDBList catalog: ${userCatalog.id}`);
          const result = await createMDBListCatalog(userCatalog, config.apiKeys?.mdblist, mdblistGenresStandard, mdblistGenresAnime, showPrefix, prefixName);
          logger.debug(`MDBList catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (isTrakt(userCatalog.id)) {
          logger.debug(`Processing Trakt catalog: ${userCatalog.id}`);
          const result = await createTraktCatalog(userCatalog, traktGenresMovies, traktGenresShows, showPrefix, prefixName);
          logger.debug(`Trakt catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (isSimkl(userCatalog.id)) {
          logger.debug(`Processing Simkl catalog: ${userCatalog.id}`);
          const result = await createSimklCatalog(userCatalog, showPrefix, prefixName);
          logger.debug(`Simkl catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (isPublicMetaDB(userCatalog.id)) {
          logger.debug(`Processing PublicMetaDB catalog: ${userCatalog.id}`);
          const result = createPublicMetaDBCatalog(userCatalog, showPrefix, prefixName);
          return result;
      }
      if (userCatalog.id.startsWith('tmdb.list.')) {
          logger.debug(`Processing TMDB List catalog: ${userCatalog.id}`);
          const result = await createTMDBListCatalog(userCatalog, genres_movie_names, genres_series_names, showPrefix, prefixName);
          logger.debug(`TMDB List catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (userCatalog.id.startsWith('tmdb.discover.')) {
          logger.debug(`Processing TMDB Discover catalog: ${userCatalog.id}`);
          const result = createTMDBDiscoverCatalog(userCatalog, genres_movie_names, genres_series_names, showPrefix, prefixName);
          logger.debug(`TMDB Discover catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (userCatalog.id.startsWith('tvdb.discover.')) {
          logger.debug(`Processing TVDB Discover catalog: ${userCatalog.id}`);
          const result = createTVDBDiscoverCatalog(userCatalog, genres_tvdb_all_names, showPrefix, prefixName);
          logger.debug(`TVDB Discover catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (userCatalog.id.startsWith('stremthru.')) {
          const result = await createStremThruCatalog(userCatalog, showPrefix, prefixName);
          return result;
      }
      if (userCatalog.id.startsWith('custom.')) {
          logger.debug(`Processing Custom catalog: ${userCatalog.id}`);
          const result = await createStremThruCatalog(userCatalog, showPrefix, prefixName);
          logger.debug(`Custom catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (userCatalog.id.startsWith('anilist.')) {
          logger.debug(`Processing AniList catalog: ${userCatalog.id}`);
          const result = createAniListCatalog(userCatalog, showPrefix, prefixName);
          logger.debug(`AniList catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if(userCatalog.id.startsWith('mal.discover')){
        logger.debug(`Processing mal discover catalog: ${userCatalog.id}`);
        const result = await createMalCatalog(userCatalog, animeGenreNames, showPrefix, prefixName);
        logger.debug(`Mal discover catalog result:`, result ? 'success' : 'failed');
        return result;
      }
      if (userCatalog.id.startsWith('letterboxd.')) {
          logger.debug(`Processing Letterboxd catalog: ${userCatalog.id}`);
          const result = await createLetterboxdCatalog(userCatalog, showPrefix, prefixName);
          logger.debug(`Letterboxd catalog result:`, result ? 'success' : 'failed');
          return result;
      }
      if (userCatalog.id.startsWith('flixpatrol.')) {
          logger.debug(`Processing FlixPatrol catalog: ${userCatalog.id}`);
          const catalogType = userCatalog.displayType || userCatalog.type;
          const extra = userCatalog.showInHome
            ? []
            : [{ name: "genre", options: ["None"], isRequired: true }];
          return {
            id: userCatalog.id,
            type: catalogType,
            name: `${showPrefix ? `${prefixName} - ` : ""}${userCatalog.name}`,
            pageSize: 10,
            extra,
            showInHome: userCatalog.showInHome
          };
      }
      const catalogDef = getCatalogDefinition(userCatalog.id);
      let catalogOptions: string[];

      if (userCatalog.id.startsWith('tvdb.') && !userCatalog.id.includes('collections')) {
        const excludedGenres = ['awards show', 'podcast', 'game show', 'news'];
        catalogOptions = genres_tvdb_all_names
          .filter((name: string) => !excludedGenres.includes(name.toLowerCase()))
          .sort();
      }
      else if (userCatalog.id === 'tvdb.collections') {
        const genres = ['None'];
        return createCatalog(
          userCatalog.id,
          userCatalog.type,
          catalogDef,
          genres,
          showPrefix,
          translatedCatalogs,
          userCatalog.showInHome,
          userCatalog.name,
          userCatalog.displayType,
          prefixName
        );
      }
      else if (userCatalog.id === 'mal.genres') {
          catalogOptions = animeGenreNames;
      } else if (userCatalog.id === 'mal.studios'){
        catalogOptions = studioNames.length > 0 ? studioNames : ['None'];
      }
      else if (userCatalog.id === 'mal.schedule') {
        catalogOptions = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      }
      else if (userCatalog.id === 'tvmaze.schedule') {
        const countries = ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'ES', 'BR'];
        catalogOptions = userCatalog.showInHome ? countries : ['None', ...countries];
      }
      else if (userCatalog.id === 'mal.seasons') {
        if ((global as any).availableSeasons && (global as any).availableSeasons.length > 0) {
          catalogOptions = (global as any).availableSeasons;
        } else {
          const seasons = ['Winter', 'Spring', 'Summer', 'Fall'];
          const currentDate = new Date();
          const currentYear = currentDate.getFullYear();
          const currentMonth = currentDate.getMonth();

          let currentSeasonIndex: number;
          if (currentMonth <= 2) currentSeasonIndex = 0;
          else if (currentMonth <= 5) currentSeasonIndex = 1;
          else if (currentMonth <= 8) currentSeasonIndex = 2;
          else currentSeasonIndex = 3;

          const seasonOptions: string[] = [];

          for (let year = currentYear; year >= 2000; year--) {
            const maxSeasonIndex = (year === currentYear) ? currentSeasonIndex : 3;
            for (let s = maxSeasonIndex; s >= 0; s--) {
              seasonOptions.push(`${seasons[s]} ${year}`);
            }
          }

          catalogOptions = seasonOptions;
        }
      }
      else if (userCatalog.id === 'mal.airing' || userCatalog.id === 'mal.upcoming' ||
               userCatalog.id === 'mal.top_movies' || userCatalog.id === 'mal.top_series' ||
               userCatalog.id === 'mal.most_favorites' || userCatalog.id === 'mal.most_popular' ||
               userCatalog.id === 'mal.top_anime') {
        catalogOptions = ['None'];
      }
      else if (userCatalog.id.startsWith('mal.') && !['mal.airing', 'mal.upcoming', 'mal.schedule', 'mal.seasons', 'mal.top_movies', 'mal.top_series', 'mal.most_favorites', 'mal.top_anime', 'mal.most_popular'].includes(userCatalog.id)) {
        catalogOptions = userCatalog.showInHome ? animeGenreNames : ['None', ...animeGenreNames];
      }
      else {
        catalogOptions = getOptionsForCatalog(catalogDef, userCatalog.type, userCatalog.showInHome, options);
        if ((userCatalog.id.startsWith('streaming.') || userCatalog.id.startsWith('tmdb.top') || userCatalog.id.startsWith('tmdb.top_rated') || userCatalog.id.startsWith('tmdb.airing_today')) && userCatalog.showInHome === false) {
          catalogOptions = ['None', ...catalogOptions];
        }
      }

      const catalog = createCatalog(
          userCatalog.id,
          userCatalog.type,
          catalogDef,
          catalogOptions,
          showPrefix,
          translatedCatalogs,
          userCatalog.showInHome,
          userCatalog.name,
          userCatalog.displayType,
          prefixName
      );
      return catalog;
    }));

  catalogs = catalogs.filter(Boolean);

  const seen = new Set<string>();
  catalogs = catalogs.filter(cat => {
    const key = `${cat.id}:${cat.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const isSearchEnabled = config.search?.enabled ?? true;
  const engineEnabled = config.search?.engineEnabled || {};
  const searchProviders = config.search?.providers || {};
  const searchNames = config.search?.searchNames || {};
  const searchDisplayTypes = config.search?.searchDisplayTypes || {};
  const legacyProviderNames = config.search?.providerNames || {};
  const defaultSearchOrder = [
    'movie',
    'series',
    'tvdb.collections.search',
    'gemini.search',
    'anime_series',
    'anime_movie',
    'people_search_movie',
    'people_search_series',
  ];
  const rawSearchOrder = Array.isArray(config.search?.searchOrder) ? config.search.searchOrder : [];
  const searchOrder = Array.from(new Set([...rawSearchOrder, ...defaultSearchOrder]));

  const getDefaultSearchName = (searchId: string): string => {
    const searchNameMap: Record<string, string> = {
      'movie': 'Movies Search',
      'series': 'Series Search',
      'anime_series': 'Anime Series Search',
      'anime_movie': 'Anime Movies Search',
      'tvdb.collections.search': 'TVDB Collections',
      'gemini.search': 'AI Search',
      'people_search_movie': 'People Search',
      'people_search_series': 'People Search',
    };
    return searchNameMap[searchId] || searchId;
  };

  const getSearchCatalogName = (searchId: string, prefix: string = '', suffix: string = 'Search'): string => {
    const customName = searchNames[searchId];
    if (customName) {
      return `${prefix}${customName}`;
    }

    let legacyName: string | null = null;
    if (searchId === 'movie' && legacyProviderNames[searchProviders.movie]) {
      legacyName = legacyProviderNames[searchProviders.movie];
    } else if (searchId === 'series' && legacyProviderNames[searchProviders.series]) {
      legacyName = legacyProviderNames[searchProviders.series];
    } else if (searchId === 'anime_series' && legacyProviderNames[searchProviders.anime_series]) {
      legacyName = legacyProviderNames[searchProviders.anime_series];
    } else if (searchId === 'anime_movie' && legacyProviderNames[searchProviders.anime_movie]) {
      legacyName = legacyProviderNames[searchProviders.anime_movie];
    } else if (searchId === 'tvdb.collections.search' && legacyProviderNames['tvdb.collections.search']) {
      legacyName = legacyProviderNames['tvdb.collections.search'];
    } else if (searchId === 'gemini.search' && legacyProviderNames['gemini.search']) {
      legacyName = legacyProviderNames['gemini.search'];
    }

    if (legacyName) {
      return `${prefix}${legacyName}`;
    }

    return `${prefix}${getDefaultSearchName(searchId)}`;
  };

  const getSearchCatalogType = (searchId: string, defaultType: string): string => {
    const customType = searchDisplayTypes[searchId];
    if (customType) {
      return customType;
    }
    return defaultType;
  };

  if (isSearchEnabled) {
    const prefix = showPrefix ? `${prefixName} - ` : "";

    const searchCatalogConfigs = [
      {
        id: 'movie',
        type: 'movie',
        provider: searchProviders.movie,
        enabled: engineEnabled[searchProviders.movie] !== false,
        suffix: 'Search'
      },
      {
        id: 'series',
        type: 'series',
        provider: searchProviders.series,
        enabled: engineEnabled[searchProviders.series] !== false,
        suffix: 'Search'
      },
      {
        id: 'tvdb.collections.search',
        type: 'collection',
        provider: 'tvdb.collections.search',
        enabled: engineEnabled['tvdb.collections.search'] !== false,
        suffix: 'Collections'
      },
      {
        id: 'anime_series',
        type: 'anime.series',
        provider: searchProviders.anime_series,
        enabled: engineEnabled[searchProviders.anime_series] !== false,
        suffix: 'Anime Search'
      },
      {
        id: 'anime_movie',
        type: 'anime.movie',
        provider: searchProviders.anime_movie,
        enabled: engineEnabled[searchProviders.anime_movie] !== false,
        suffix: 'Anime Search'
      },
      {
        id: 'people_search_movie',
        type: 'movie',
        provider: config.search?.providers?.people_search_movie || 'tmdb.people.search',
        enabled: engineEnabled['people_search_movie'] !== false,
        suffix: 'People Search'
      },
      {
        id: 'people_search_series',
        type: 'series',
        provider: config.search?.providers?.people_search_series || 'tmdb.people.search',
        enabled: engineEnabled['people_search_series'] !== false,
        suffix: 'People Search'
      },
      {
        id: 'gemini.search',
        type: 'other',
        provider: 'gemini.search',
        enabled: engineEnabled['gemini.search'] !== false && config.search?.ai_enabled === true && (!!config.apiKeys?.gemini || !!config.apiKeys?.openrouter),
        suffix: 'AI Search'
      }
    ];

    searchCatalogConfigs
      .sort((a, b) => {
        const aIndex = searchOrder.indexOf(a.id);
        const bIndex = searchOrder.indexOf(b.id);
        const aPos = aIndex === -1 ? Infinity : aIndex;
        const bPos = bIndex === -1 ? Infinity : bIndex;
        return aPos - bPos;
      })
      .filter(config => config.enabled)
      .forEach(config => {
        let catalogId: string;
        if (config.provider === 'gemini.search') {
          catalogId = 'gemini.search';
        } else if (config.id === 'people_search_movie' || config.id === 'people_search_series') {
          catalogId = `people_search.${config.id}`;
        } else {
          catalogId = `search.${config.id}`;
        }
        catalogs.push({
          id: catalogId,
          type: getSearchCatalogType(config.id, config.type),
          name: getSearchCatalogName(config.id, prefix, config.suffix),
          extra: [{ name: 'search', isRequired: true }, { name: 'skip' }]
        });
      });
    const isMalSearchInUse = Object.entries(searchProviders).some(
      ([key, providerId]: [string, any]) =>
        typeof providerId === 'string' &&
        providerId.startsWith('mal.search') &&
        engineEnabled[providerId] !== false
    );
    if (isMalSearchInUse) {
      const searchVAAnime = {
        id: "mal.va_search",
        type: "anime",
        name: `${prefix}Voice Actor Roles`,
        extra: [{ name: "va_id", isRequired: true }]
      };
      const searchGenreAnime = {
        id: "mal.genre_search",
        type: "anime",
        name: `${prefix}Anime Genre`,
        extra: [{ name: "genre_id", isRequired: true }]
      };
      catalogs.push(searchVAAnime, searchGenreAnime);
    }
  }

  catalogs.push({
    type: "series",
    id: "calendar-videos",
    extra: [
      {
        name: "calendarVideosIds",
        isRequired: true,
        optionsLimit: 100
      }
    ],
    extraSupported: [
      "calendarVideosIds"
    ],
    extraRequired: [
      "calendarVideosIds"
    ],
    name: "Calendar videos"
  });

  const activeConfigs = [
    `Language: ${language}`,
    `TMDB Account: ${sessionId ? 'Connected' : 'Not Connected'}`,
    `MDBList Integration: ${config.apiKeys?.mdblist ? 'Connected' : 'Not Connected'}`,
    `IMDb Integration: ${provideImdbId ? 'Enabled' : 'Disabled'}`,
    `RPDB Integration: ${config.apiKeys?.rpdb } ? 'Enabled' : 'Disabled'}`,
    `Search: ${config.searchEnabled !== "false" ? 'Enabled' : 'Disabled'}`,
    `Active Catalogs: ${catalogs.length}`
  ].join(' | ');


  const nameSuffix = process.env.ADDON_NAME_SUFFIX || "";
  const baseName = config.addonName || (nameSuffix ? `AIOMetadata ${nameSuffix}` : "AIOMetadata");
  const addonName = baseName;

  const resources: string[] = ["catalog"];
  if (!config.catalogModeOnly) {
    resources.push("meta");
  }
  resources.push("subtitles");
  if(config.showRateMeButton) {
    resources.push("stream");
  }

  const manifest = {
    id: buildInfo.name,
    version: buildInfo.version,
    logo: manifestLogoUrl,
    background: `${host}/background.png`,
    name: addonName,
    description: "A metadata addon for power users. AIOMetadata uses TMDB, TVDB, TVMaze, MyAnimeList, IMDB and Fanart.tv to provide accurate data for movies, series, and anime. You choose the source.",
    resources,
    types: ["movie", "series", "anime.movie", "anime.series", "anime", "Trakt", "collection"],
    idPrefixes: ["tmdb:", "tt", "tvdb:", "mal:", "tvmaze:", "kitsu:", "anidb:", "anilist:", "tvdbc:", "upnext_", "unwatched_", "mdblist_upnext_"],
    stremioAddonsConfig: {
      "issuer": "https://stremio-addons.net",
      "signature": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..3_iKJ-pKhR-LclfTPxvyag.uY747PgjymdL0OMdZrE7HTOVG-8nNWC-LrlJ5tCXm2i2FioXv_ismzWV0_XsLl0Me9cW9D3xog6d4tSHDY8Pe27mbIylUb61MS4VVqg_sFZXUVon2le-fRFrtmMnIqCF.oyYRDftPN2sohMpDMbMbYg"
    },
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      newEpisodeNotifications: true
    },
    catalogs,
  };

  const endTime = Date.now();
  const mdblistCatalogCount = catalogs.filter((catalog: any) => catalog.id?.startsWith('mdblist.')).length;
  logger.success(`Manifest generation completed in ${endTime - startTime}ms (catalogs: ${catalogs.length}, enabled user catalogs: ${enabledCatalogs.length}, MDBList: ${mdblistCatalogCount})`);

  return manifest;
}

function getDefaultCatalogs(): any[] {
  const defaultTypes = ['movie', 'series'];
  const defaultTmdbCatalogs = Object.keys(CATALOG_TYPES.default);
  const defaultTvdbCatalogs = Object.keys(CATALOG_TYPES.tvdb);
  const defaultMalCatalogs = Object.keys(CATALOG_TYPES.mal);
  const defaultStreamingCatalogs = Object.keys(CATALOG_TYPES.streaming);

  const tmdbCatalogs = defaultTmdbCatalogs.flatMap((id: string) =>
    defaultTypes.map(type => ({
      id: `tmdb.${id}`,
      type,
      showInHome: true,
      enabled: true
    }))
  );
  const tvdbCatalogs = defaultTvdbCatalogs.flatMap((id: string) =>
    id === 'collections'
      ? [{ id: `tvdb.${id}`, type: 'series', showInHome: false, enabled: true }]
      : defaultTypes.map(type => ({
          id: `tvdb.${id}`,
          type,
          showInHome: false,
          enabled: true
        }))
  );
  const malCatalogs = defaultMalCatalogs.map((id: string) => ({
    id: `mal.${id}`,
    type: 'anime',
    showInHome: !['genres', 'schedule'].includes(id),
    enabled: true
  }));

  const streamingCatalogs = defaultStreamingCatalogs.flatMap((id: string) =>
    defaultTypes.map(type => ({
    id: `streaming.${id}`,
    type,
    showInHome: false,
    enabled: true
  }))
  );

  return [...tmdbCatalogs, ...tvdbCatalogs, ...malCatalogs, ...streamingCatalogs];
}

export { getManifest, DEFAULT_LANGUAGE };
module.exports = { getManifest, DEFAULT_LANGUAGE };
