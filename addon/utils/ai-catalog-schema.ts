const VALID_SOURCES = ['tmdb', 'tvdb', 'anilist', 'mal', 'simkl'] as const;
export const AI_CATALOG_GENERATION_MODES = ['auto', 'tmdb', 'anilist', 'mal', 'tvdb', 'simkl'] as const;

type AICatalogGenerationMode = typeof AI_CATALOG_GENERATION_MODES[number];

interface AICatalogOutput {
  source: string;
  catalogType: string;
  name: string;
  mediaType: string;
  params: Record<string, any>;
  resolve?: Record<string, string[]>;
}

interface ParsedAIResponse {
  catalogs: AICatalogOutput[];
  warnings?: string[];
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

interface ResolvedEntity {
  id: number;
  name: string;
}

interface AvailableKeys {
  tmdb?: boolean;
  tvdb?: boolean;
  simkl?: boolean;
}

interface ResolveContext {
  tmdbApiKey?: string;
  tvdbApiKey?: string;
  userUUID?: string;
}

interface ResolveResult {
  resolved: Record<string, string>;
  warnings: string[];
}

interface CatalogConfig {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  showInHome: boolean;
  source: string;
  cacheTTL?: number;
  metadata: {
    description: string;
    discover: {
      version: number;
      source: string;
      mediaType: string;
      params: Record<string, any>;
      formState: Record<string, any>;
    };
  };
}

const VALID_TMDB_MOVIE_SORTS = ['popularity.desc', 'popularity.asc', 'primary_release_date.desc', 'primary_release_date.asc', 'vote_average.desc', 'vote_average.asc', 'vote_count.desc', 'revenue.desc'];
const VALID_TMDB_TV_SORTS = ['popularity.desc', 'popularity.asc', 'first_air_date.desc', 'first_air_date.asc', 'vote_average.desc', 'vote_average.asc', 'vote_count.desc'];
const VALID_ANILIST_SORTS = ['TRENDING_DESC', 'POPULARITY_DESC', 'POPULARITY', 'SCORE_DESC', 'SCORE', 'FAVOURITES_DESC', 'START_DATE_DESC', 'START_DATE', 'UPDATED_AT_DESC', 'TITLE_ROMAJI', 'TITLE_ENGLISH', 'EPISODES_DESC'];
const VALID_MAL_SORTS = ['score', 'popularity', 'rank', 'members', 'favorites', 'start_date', 'end_date', 'episodes', 'title'];
const VALID_SIMKL_MOVIE_SORTS = ['popular-this-week', 'popular-this-month', 'rank', 'votes', 'budget', 'revenue', 'release-date', 'most-anticipated', 'a-z', 'z-a'];
const VALID_SIMKL_TV_SORTS = ['popular-today', 'popular-this-week', 'popular-this-month', 'rank', 'votes', 'release-date', 'last-air-date', 'a-z', 'z-a'];
const VALID_TVDB_SORTS = ['score', 'firstAired', 'name', 'lastAired'];
const VALID_TVDB_MOVIE_SORTS = ['score', 'firstAired', 'name'];

const VALID_ANILIST_GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Hentai', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
const VALID_ANILIST_TAGS = ['Isekai', 'Time Travel', 'Super Power', 'School', 'Military', 'Magic', 'Demons', 'Vampire', 'Gore', 'Samurai', 'Historical', 'Space', 'Cooking', 'Reincarnation', 'Martial Arts', 'Robots', 'Kids', 'Primarily Child Cast', 'Cute Girls Doing Cute Things', 'Harem', 'Reverse Harem', 'Fanservice'];
const VALID_ANILIST_FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA'];
const VALID_ANILIST_SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL', 'CURRENT'];
const VALID_ANILIST_STATUSES = ['FINISHED', 'RELEASING', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS'];
const VALID_ANILIST_COUNTRIES = ['JP', 'KR', 'CN', 'TW'];
const VALID_MAL_TYPES = ['tv', 'movie', 'ova', 'special', 'ona', 'music'];
const VALID_MAL_STATUSES = ['airing', 'complete', 'upcoming'];
const VALID_MAL_RATINGS = ['g', 'pg', 'pg13', 'r17', 'r', 'rx'];
const VALID_MAL_SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL', 'CURRENT'];
const VALID_MAL_SORT_DIRECTIONS = ['asc', 'desc'];
const VALID_SIMKL_MEDIA = ['movies', 'shows', 'anime'];
const VALID_SIMKL_MOVIE_GENRES = ['action', 'adventure', 'animation', 'comedy', 'crime', 'documentary', 'drama', 'erotica', 'family', 'fantasy', 'history', 'horror', 'music', 'mystery', 'romance', 'science-fiction', 'thriller', 'tv-movie', 'war', 'western'];
const VALID_SIMKL_SHOW_GENRES = ['action', 'adventure', 'animation', 'awards-show', 'children', 'comedy', 'crime', 'documentary', 'drama', 'family', 'fantasy', 'food', 'game-show', 'history', 'home-and-garden', 'horror', 'indie', 'korean-drama', 'martial-arts', 'mini-series', 'musical', 'mystery', 'news', 'podcast', 'reality', 'romance', 'science-fiction', 'soap', 'special-interest', 'sport', 'suspense', 'talk-show', 'thriller', 'travel', 'video-game-play', 'war', 'western'];
const VALID_SIMKL_ANIME_GENRES = ['action', 'adventure', 'comedy', 'drama', 'ecchi', 'educational', 'fantasy', 'gag-humor', 'gore', 'harem', 'historical', 'horror', 'idol', 'isekai', 'josei', 'kids', 'magic', 'martial-arts', 'mecha', 'military', 'music', 'mystery', 'mythology', 'parody', 'psychological', 'racing', 'reincarnation', 'romance', 'samurai', 'school', 'sci-fi', 'seinen', 'shoujo', 'shoujo-ai', 'shounen', 'shounen-ai', 'slice-of-life', 'space', 'sports', 'strategy-game', 'super-power', 'supernatural', 'thriller', 'vampire', 'yaoi', 'yuri'];
const VALID_SIMKL_SHOW_TYPES = ['all-types', 'tv-shows', 'entertainment', 'documentaries', 'animation-filter'];
const VALID_SIMKL_ANIME_TYPES = ['all-types', 'series', 'movies', 'ovas', 'onas', 'specials', 'music'];
const VALID_SIMKL_MOVIE_COUNTRIES = ['all', 'us', 'uk', 'ca', 'kr'];
const VALID_SIMKL_SHOW_COUNTRIES = ['all', 'us', 'uk', 'ca', 'kr', 'jp'];
const VALID_SIMKL_SHOW_NETWORKS = ['all-networks', 'netflix', 'disney', 'peacock', 'appletv', 'quibi', 'cbs', 'abc', 'fox', 'cw', 'hbo', 'showtime', 'usa', 'syfy', 'tnt', 'fx', 'amc', 'abcfam', 'showcase', 'starz', 'mtv', 'lifetime', 'ae', 'tvland'];
const VALID_SIMKL_ANIME_NETWORKS = ['all-networks', 'tvtokyo', 'tokyomx', 'fujitv', 'tokyobroadcastingsystem', 'tvasahi', 'wowow', 'ntv', 'atx', 'ctc', 'nhk', 'mbs', 'animax', 'cartoonnetwork', 'abc'];
const VALID_SIMKL_YEAR_SHORTCUTS = ['all-years', 'today', 'this-week', 'this-month', 'this-year'];

const VALID_TMDB_MOVIE_GENRES = new Set([28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37]);
const VALID_TMDB_TV_GENRES = new Set([10759, 16, 35, 80, 99, 18, 10751, 10762, 9648, 10763, 10764, 10765, 10766, 10767, 10768, 37]);

const MAL_GENRE_NAMES: Record<number, string> = {
  1: 'Action', 2: 'Adventure', 3: 'Racing', 4: 'Comedy', 5: 'Avant Garde', 6: 'Mythology',
  7: 'Mystery', 8: 'Drama', 9: 'Ecchi', 10: 'Fantasy', 11: 'Strategy Game', 12: 'Hentai',
  13: 'Historical', 14: 'Horror', 15: 'Kids', 17: 'Martial Arts', 18: 'Mecha', 19: 'Music',
  20: 'Parody', 21: 'Samurai', 22: 'Romance', 23: 'School', 24: 'Sci-Fi', 25: 'Shoujo',
  26: 'Girls Love', 27: 'Shounen', 28: 'Boys Love', 29: 'Space', 30: 'Sports', 31: 'Super Power',
  32: 'Vampire', 35: 'Harem', 36: 'Slice of Life', 37: 'Supernatural', 38: 'Military',
  39: 'Detective', 40: 'Psychological', 41: 'Suspense', 42: 'Seinen', 43: 'Josei',
  46: 'Award Winning', 47: 'Gourmet', 48: 'Workplace', 49: 'Erotica', 50: 'Adult Cast',
  51: 'Anthropomorphic', 52: 'CGDCT', 53: 'Childcare', 54: 'Combat Sports', 55: 'Delinquents',
  56: 'Educational', 57: 'Gag Humor', 58: 'Gore', 59: 'High Stakes Game', 60: 'Idols (Female)',
  61: 'Idols (Male)', 62: 'Isekai', 63: 'Iyashikei', 64: 'Love Polygon', 65: 'Magical Sex Shift',
  66: 'Mahou Shoujo', 67: 'Medical', 68: 'Organized Crime', 69: 'Otaku Culture',
  70: 'Performing Arts', 71: 'Pets', 72: 'Reincarnation', 73: 'Reverse Harem',
  74: 'Love Status Quo', 75: 'Showbiz', 76: 'Survival', 77: 'Team Sports', 78: 'Time Travel',
  79: 'Video Game', 80: 'Visual Arts', 81: 'Crossdressing', 82: 'Urban Fantasy', 83: 'Villainess',
};

const TMDB_GENRE_NAMES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller',
  10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News',
  10764: 'Reality', 10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

const TMDB_MOVIE_GENRE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(TMDB_GENRE_NAMES).filter(([id]) => VALID_TMDB_MOVIE_GENRES.has(Number(id)))
) as Record<number, string>;
const TMDB_TV_GENRE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(TMDB_GENRE_NAMES).filter(([id]) => VALID_TMDB_TV_GENRES.has(Number(id)))
) as Record<number, string>;

const SORT_CORRECTIONS: Record<string, Record<string, string>> = {
  series: { 'primary_release_date.desc': 'first_air_date.desc', 'primary_release_date.asc': 'first_air_date.asc', 'revenue.desc': 'popularity.desc' },
  movie: { 'first_air_date.desc': 'primary_release_date.desc', 'first_air_date.asc': 'primary_release_date.asc' },
};
const SIMKL_MEDIA_TO_CATALOG_TYPE: Record<string, string> = {
  movies: 'movie',
  shows: 'series',
  anime: 'anime',
};
const CATALOG_TYPE_TO_SIMKL_MEDIA: Record<string, string> = {
  movie: 'movies',
  series: 'shows',
  anime: 'anime',
};

const TMDB_COMMON_PARAMS = new Set([
  'include_adult',
  'language',
  'page',
  'sort_by',
  'vote_average.gte',
  'vote_average.lte',
  'vote_count.gte',
  'vote_count.lte',
  'watch_region',
  'with_companies',
  'without_companies',
  'with_genres',
  'without_genres',
  'with_keywords',
  'without_keywords',
  'with_origin_country',
  'with_original_language',
  'with_runtime.gte',
  'with_runtime.lte',
  'with_watch_monetization_types',
  'with_watch_providers',
  'without_watch_providers',
]);
const TMDB_MOVIE_PARAMS = new Set([
  'certification',
  'certification.gte',
  'certification.lte',
  'certification_country',
  'include_video',
  'primary_release_year',
  'primary_release_date.gte',
  'primary_release_date.lte',
  'release_date.gte',
  'release_date.lte',
  'region',
  'with_cast',
  'with_crew',
  'with_people',
  'with_release_type',
  'year',
]);
const TMDB_TV_PARAMS = new Set([
  'air_date.gte',
  'air_date.lte',
  'first_air_date_year',
  'first_air_date.gte',
  'first_air_date.lte',
  'include_null_first_air_dates',
  'screened_theatrically',
  'timezone',
  'with_networks',
  'with_status',
  'with_type',
]);
const ANILIST_PARAMS = new Set([
  'averageScore_greater',
  'averageScore_lesser',
  'countryOfOrigin',
  'duration_greater',
  'duration_lesser',
  'episodes_greater',
  'episodes_lesser',
  'format_in',
  'genre_in',
  'genre_not_in',
  'isAdult',
  'popularity_greater',
  'season',
  'seasonYear',
  'sort',
  'startDate_greater',
  'startDate_lesser',
  'status',
  'studios',
  'tag_in',
  'tag_not_in',
]);
const MAL_PARAMS = new Set([
  'end_date',
  'genres',
  'genres_exclude',
  'max_score',
  'min_score',
  'order_by',
  'producers',
  'rating',
  'season',
  'seasonYear',
  'sfw',
  'sort',
  'start_date',
  'status',
  'type',
]);
const SIMKL_PARAMS = new Set(['country', 'genre', 'media', 'network', 'sort', 'type', 'year']);
const TVDB_PARAMS = new Set(['country', 'lang', 'sort', 'sortType', 'year']);

const TMDB_MOVIE_ALLOWED_PARAMS = new Set([...TMDB_COMMON_PARAMS, ...TMDB_MOVIE_PARAMS]);
const TMDB_TV_ALLOWED_PARAMS = new Set([...TMDB_COMMON_PARAMS, ...TMDB_TV_PARAMS]);

const SOURCE_SCHEMAS = {
  tmdb: {
    movie: {
      sortParam: 'sort_by',
      sorts: VALID_TMDB_MOVIE_SORTS,
      params: TMDB_MOVIE_ALLOWED_PARAMS,
      genreIds: VALID_TMDB_MOVIE_GENRES,
      genreNames: TMDB_MOVIE_GENRE_NAMES,
    },
    series: {
      sortParam: 'sort_by',
      sorts: VALID_TMDB_TV_SORTS,
      params: TMDB_TV_ALLOWED_PARAMS,
      genreIds: VALID_TMDB_TV_GENRES,
      genreNames: TMDB_TV_GENRE_NAMES,
    },
  },
  anilist: {
    anime: {
      sortParam: 'sort',
      sorts: VALID_ANILIST_SORTS,
      params: ANILIST_PARAMS,
      genres: VALID_ANILIST_GENRES,
      tags: VALID_ANILIST_TAGS,
      formats: VALID_ANILIST_FORMATS,
      seasons: VALID_ANILIST_SEASONS,
      statuses: VALID_ANILIST_STATUSES,
      countries: VALID_ANILIST_COUNTRIES,
    },
  },
  mal: {
    anime: {
      sortParam: 'order_by',
      sorts: VALID_MAL_SORTS,
      sortDirections: VALID_MAL_SORT_DIRECTIONS,
      params: MAL_PARAMS,
      genres: MAL_GENRE_NAMES,
      types: VALID_MAL_TYPES,
      statuses: VALID_MAL_STATUSES,
      ratings: VALID_MAL_RATINGS,
      seasons: VALID_MAL_SEASONS,
    },
  },
  simkl: {
    media: VALID_SIMKL_MEDIA,
    movies: {
      sortParam: 'sort',
      sorts: VALID_SIMKL_MOVIE_SORTS,
      params: SIMKL_PARAMS,
      genres: VALID_SIMKL_MOVIE_GENRES,
      countries: VALID_SIMKL_MOVIE_COUNTRIES,
      yearShortcuts: VALID_SIMKL_YEAR_SHORTCUTS,
    },
    shows: {
      sortParam: 'sort',
      sorts: VALID_SIMKL_TV_SORTS,
      params: SIMKL_PARAMS,
      genres: VALID_SIMKL_SHOW_GENRES,
      types: VALID_SIMKL_SHOW_TYPES,
      countries: VALID_SIMKL_SHOW_COUNTRIES,
      networks: VALID_SIMKL_SHOW_NETWORKS,
      yearShortcuts: VALID_SIMKL_YEAR_SHORTCUTS,
    },
    anime: {
      sortParam: 'sort',
      sorts: VALID_SIMKL_TV_SORTS,
      params: SIMKL_PARAMS,
      genres: VALID_SIMKL_ANIME_GENRES,
      types: VALID_SIMKL_ANIME_TYPES,
      networks: VALID_SIMKL_ANIME_NETWORKS,
      yearShortcuts: VALID_SIMKL_YEAR_SHORTCUTS,
    },
  },
  tvdb: {
    movie: {
      sortParam: 'sort',
      sorts: VALID_TVDB_MOVIE_SORTS,
      sortDirections: ['asc', 'desc'],
      params: TVDB_PARAMS,
    },
    series: {
      sortParam: 'sort',
      sorts: VALID_TVDB_SORTS,
      sortDirections: ['asc', 'desc'],
      params: TVDB_PARAMS,
    },
  },
} as const;

function getSchemaTypeForCatalog(source: string, catalogType: string, params: Record<string, any> = {}): string {
  if (source === 'tmdb' || source === 'tvdb') return catalogType === 'series' ? 'series' : 'movie';
  if (source === 'anilist' || source === 'mal') return 'anime';
  if (source === 'simkl') {
    const media = typeof params.media === 'string' ? params.media.trim().toLowerCase() : '';
    if (media === 'movies' || media === 'shows' || media === 'anime') return media;
    if (catalogType === 'series') return 'shows';
    if (catalogType === 'anime') return 'anime';
    return 'movies';
  }
  return catalogType;
}

function getSourceSchema(source: string, catalogType: string, params: Record<string, any> = {}): any | null {
  const sourceSchemas = (SOURCE_SCHEMAS as Record<string, Record<string, any>>)[source];
  if (!sourceSchemas) return null;
  const schemaType = getSchemaTypeForCatalog(source, catalogType, params);
  return sourceSchemas[schemaType] || null;
}

function getAllowedCatalogParams(source: string, catalogType: string, params: Record<string, any> = {}): ReadonlySet<string> | null {
  return getSourceSchema(source, catalogType, params)?.params || null;
}

function getCatalogSorts(source: string, catalogType: string, params: Record<string, any> = {}): readonly string[] {
  return getSourceSchema(source, catalogType, params)?.sorts || [];
}

export {
  VALID_SOURCES,
  SOURCE_SCHEMAS,
  getAllowedCatalogParams,
  getCatalogSorts,
  getSourceSchema,
  VALID_TMDB_MOVIE_SORTS,
  VALID_TMDB_TV_SORTS,
  VALID_ANILIST_SORTS,
  VALID_MAL_SORTS,
  VALID_SIMKL_MOVIE_SORTS,
  VALID_SIMKL_TV_SORTS,
  VALID_SIMKL_MEDIA,
  VALID_SIMKL_MOVIE_GENRES,
  VALID_SIMKL_SHOW_GENRES,
  VALID_SIMKL_ANIME_GENRES,
  VALID_SIMKL_SHOW_TYPES,
  VALID_SIMKL_ANIME_TYPES,
  VALID_SIMKL_MOVIE_COUNTRIES,
  VALID_SIMKL_SHOW_COUNTRIES,
  VALID_SIMKL_SHOW_NETWORKS,
  VALID_SIMKL_ANIME_NETWORKS,
  VALID_SIMKL_YEAR_SHORTCUTS,
  VALID_TVDB_SORTS,
  VALID_TVDB_MOVIE_SORTS,
  VALID_ANILIST_GENRES,
  VALID_ANILIST_TAGS,
  VALID_ANILIST_FORMATS,
  VALID_ANILIST_SEASONS,
  VALID_ANILIST_STATUSES,
  VALID_ANILIST_COUNTRIES,
  VALID_MAL_TYPES,
  VALID_MAL_STATUSES,
  VALID_MAL_RATINGS,
  VALID_MAL_SEASONS,
  VALID_MAL_SORT_DIRECTIONS,
  VALID_TMDB_MOVIE_GENRES,
  VALID_TMDB_TV_GENRES,
  MAL_GENRE_NAMES,
  TMDB_GENRE_NAMES,
  TMDB_MOVIE_GENRE_NAMES,
  TMDB_TV_GENRE_NAMES,
  SORT_CORRECTIONS,
  SIMKL_MEDIA_TO_CATALOG_TYPE,
  CATALOG_TYPE_TO_SIMKL_MEDIA,
  TMDB_COMMON_PARAMS,
  TMDB_MOVIE_PARAMS,
  TMDB_TV_PARAMS,
  ANILIST_PARAMS,
  MAL_PARAMS,
  SIMKL_PARAMS,
  TVDB_PARAMS,
};

export type {
  AICatalogOutput,
  ParsedAIResponse,
  AICatalogGenerationMode,
  ValidationResult,
  ResolvedEntity,
  AvailableKeys,
  ResolveContext,
  ResolveResult,
  CatalogConfig,
};
