export interface CatalogConfig {
  id: string;
  name: string;
  type: 'movie' | 'series' | 'anime' | 'all';
  enabled: boolean;
  source: 'tmdb' | 'tvdb' | 'mal' | 'tvmaze' | 'mdblist' | 'streaming' | 'stremthru' | 'custom'; // Keep source as the display label
  sourceUrl?: string; // Store the actual URL for StremThru and custom catalogs
  showInHome: boolean;
  genres?: string[]; // Optional genres array for catalogs that support genre filtering
  manifestData?: any; // Store original manifest data for advanced features like skip support
  // MDBList sorting options
  sort?: 'rank' | 'score' | 'usort' | 'score_average' | 'released' | 'releasedigital' | 'imdbrating' | 'imdbvotes' | 'last_air_date' | 'imdbpopular' | 'tmdbpopular' | 'rogerbert' | 'rtomatoes' | 'rtaudience' | 'metacritic' | 'myanimelist' | 'letterrating' | 'lettervotes' | 'budget' | 'revenue' | 'runtime' | 'title' | 'added' | 'random' | 'default';
  order?: 'asc' | 'desc';
  // Custom cache TTL for MDBList catalogs (in seconds, defaults to 24 hours)
  cacheTTL?: number;
  // Display type override - if defined, used in manifest instead of original type (free-form string)
  displayType?: string;
  // Genre selection for MDBList catalogs - which genre set to use
  genreSelection?: 'standard' | 'anime' | 'all';
  // Enable RPDB for this catalog (for poster enhancements)
  enableRatingPosters?: boolean;
  // Randomize items within each page on every load
  randomizePerPage?: boolean;
  // Page size for custom/StremThru catalogs (default: 100)
  pageSize?: number;
}

export interface SearchConfig {
    id: string;
    name: string;
    type: 'movie' | 'series' | 'anime';
    enabled: boolean;
}

export interface AppConfig {
  language: string;
  includeAdult: boolean;
  blurThumbs: boolean;
  showPrefix: boolean;
  showMetaProviderAttribution: boolean;
  castCount: number;
  displayAgeRating: boolean;
  providers: {
    movie: string;
    series: string;
    anime: string;
    anime_id_provider: 'kitsu' | 'mal' | 'imdb';
    /** If true, use anime meta provider for any catalog item detected as anime after IMDb mapping */
    forceAnimeForDetectedImdb: boolean;
  };
  artProviders: {
    movie: 'meta' | 'tmdb' | 'tvdb' | 'fanart' | 'imdb' | {
      poster: 'meta' | 'tmdb' | 'tvdb' | 'fanart' | 'imdb';
      background: 'meta' | 'tmdb' | 'tvdb' | 'fanart' | 'imdb';
      logo: 'meta' | 'tmdb' | 'tvdb' | 'fanart' | 'imdb';
    };
    series: 'meta' | 'tmdb' | 'tvdb' | 'fanart' | 'imdb' | {
      poster: 'meta' | 'tmdb' | 'tvdb' | 'fanart' | 'imdb';
      background: 'meta' | 'tmdb' | 'tvdb' | 'fanart' | 'imdb';
      logo: 'meta' | 'tmdb' | 'tvdb' | 'fanart' | 'imdb';
    };
    anime: 'meta' | 'mal' | 'anilist' | 'tvdb' | 'fanart' | 'imdb' | {
      poster: 'meta' | 'mal' | 'anilist' | 'tvdb' | 'fanart' | 'imdb';
      background: 'meta' | 'mal' | 'anilist' | 'tvdb' | 'fanart' | 'imdb';
      logo: 'meta' | 'mal' | 'anilist' | 'tvdb' | 'fanart' | 'imdb';
    };
    englishArtOnly: boolean;
  };
  tvdbSeasonType: string;
  mal: {
    skipFiller: boolean;
    skipRecap: boolean;
    allowEpisodeMarking: boolean;
    /** If true, prefer IMDb IDs for catalog and search items when available */
    useImdbIdForCatalogAndSearch?: boolean;
  };
  tmdb: {
    scrapeImdb: boolean;
    forceLatinCastNames?: boolean;
  };
  apiKeys: {
    gemini: string;
    tmdb: string;
    tvdb: string;
    fanart: string;
    rpdb: string;
    topPoster: string;
    mdblist: string;
    customDescriptionBlurb?: string;
  };
  /** Poster rating provider: 'rpdb' for RatingPosterDB or 'top' for Top Poster API */
  posterRatingProvider?: 'rpdb' | 'top';
  mdblistWatchTracking: boolean;
  /** If true, keep RPDB posters for items in Continue Watching and Library (default: true). When disabled, RPDB posters are removed since catalog context is unavailable. */
  enableRatingPostersForLibrary?: boolean;
  ageRating: string;
  sfw: boolean;
  hideUnreleasedDigital: boolean;
  exclusionKeywords?: string;
  regexExclusionFilter?: string;
  searchEnabled: boolean;
  sessionId: string;
  catalogs: CatalogConfig[];
  deletedCatalogs?: string[];
  search: {
    enabled: boolean; 
    // This is the switch for the AI layer.
    ai_enabled: boolean; 
    // This stores the primary keyword engine for each type.
    providers: {
        movie: 'tmdb.search' | 'tvdb.search' | 'mal.search.movie';
        series: 'tmdb.search' | 'tvdb.search' | 'tvmaze.search' | 'mal.search.series';
        anime_movie: 'mal.search.movie' | 'kitsu.search.movie';
        anime_series: 'mal.search.series' | 'kitsu.search.series';
    };
    // New: per-engine enable/disable
    engineEnabled?: {
      [engine: string]: boolean;
    };
    // RPDB enable/disable per search engine
    engineRatingPosters?: {
      [engine: string]: boolean;
    };
    // Custom names for search providers
    providerNames?: {
      [providerId: string]: string;
    };
    // Order of search catalogs
    searchOrder?: string[];
  };
  streaming: string[];
  displayTypeOverrides?: {
    movie?: string;
    series?: string;
  };
  catalogModeOnly?: boolean;
}
