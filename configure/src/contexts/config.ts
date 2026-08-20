import type { BuilderEntry } from '@shared/types';

export type TagColorKey =
  | 'blue' | 'green' | 'red' | 'violet' | 'amber' | 'cyan'
  | 'pink' | 'emerald' | 'orange' | 'indigo' | 'rose' | 'slate';

export const MAX_TAG_NAME_LENGTH = 32;

export interface TagDef {
  name: string;
  color: TagColorKey;
}

export interface CatalogConfig {
  id: string;
  name: string;
  type: 'movie' | 'series' | 'anime' | 'all';
  enabled: boolean;
  tags?: string[];
  source: 'tmdb' | 'tvdb' | 'mal' | 'tvmaze' | 'mdblist' | 'trakt' | 'streaming' | 'stremthru' | 'custom' | 'anilist' | 'letterboxd' | 'simkl' | 'movielens' | 'flixpatrol' | 'publicmetadb' | 'merged'; // Keep source as the display label
  sourceUrl?: string; // Store the actual URL for StremThru and custom catalogs
  showInHome: boolean;
  genres?: string[]; // Optional genres array for catalogs that support genre filtering
  manifestData?: any; // Store original manifest data for advanced features like skip support
  // MDBList, Trakt, and AniList sorting options
  sort?: 'rank' | 'score' | 'usort' | 'score_average' | 'released' | 'releasedigital' | 'imdbrating' | 'imdbvotes' | 'last_air_date' | 'imdbpopular' | 'tmdbpopular' | 'rogerbert' | 'rtomatoes' | 'rtaudience' | 'metacritic' | 'myanimelist' | 'letterrating' | 'lettervotes' | 'budget' | 'revenue' | 'runtime' | 'title' | 'added' | 'random' | 'default' | 'MEDIA_ID' | 'SCORE' | 'STATUS' | 'PROGRESS' | 'PROGRESS_VOLUMES' | 'REPEAT' | 'PRIORITY' | 'STARTED_ON' | 'FINISHED_ON' | 'ADDED_TIME' | 'UPDATED_TIME' | 'MEDIA_TITLE_ROMAJI' | 'MEDIA_TITLE_ENGLISH' | 'MEDIA_TITLE_NATIVE' | 'MEDIA_POPULARITY' | 'popularity' | 'percentage' | 'votes' | 'my_rating' | 'watched' | 'collected' | 'tmdb_rating' | 'rt_tomatometer' | 'rt_audience' | 'metascore' | 'tmdb_votes' | 'popularity' | 'release_date' | 'vote_average';
  order?: 'asc' | 'desc';
  // Trakt sorting direction
  sortDirection?: 'asc' | 'desc';
  // Custom cache TTL for MDBList catalogs (in seconds, defaults to 24 hours)
  cacheTTL?: number;
  // Display type override - if defined, used in manifest instead of original type (free-form string)
  displayType?: string;
  // Genre selection for MDBList catalogs - which genre set to use
  genreSelection?: 'standard' | 'anime' | 'all';
  // MDBList external list score filters
  filter_score_min?: number;
  filter_score_max?: number;
  // Minimum TMDB vote count filter (tmdb.year catalog)
  minVotes?: number;
  // Enable RPDB for this catalog (for poster enhancements)
  enableRatingPosters?: boolean;
  // Randomize items within each page on every load
  randomizePerPage?: boolean;
  // Page size for custom/StremThru catalogs (default: 100)
  pageSize?: number;
  /** If set, this catalog is absorbed into a merged catalog and hidden from UI/manifest */
  mergedInto?: string;
  // List metadata (item count, privacy, author, description, AniList-specific fields, Trakt Up Next settings, Letterboxd-specific fields, TMDB-specific fields)
  metadata?: {
    itemCount?: number;
    privacy?: string;
    author?: string;
    description?: string;
    // AniList-specific metadata
    username?: string;
    listName?: string;
    isCustomList?: boolean;
    // Trakt Up Next metadata
    useShowPosterForUpNext?: boolean;
    includeAnimeInUpNext?: boolean;
    // Trakt Calendar metadata
    airingSoonDays?: number;
    // Letterboxd-specific metadata
    isWatchlist?: boolean;
    // PublicMetaDB list visibility and kind, as the API reports them
    isPublic?: boolean;
    listType?: string;
    hideUnreleased?: boolean;
    hideWatchedTrakt?: boolean;
    hideWatchedAnilist?: boolean;
    hideWatchedMdblist?: boolean;
    hideWatchedSimkl?: boolean;
    hideUnreleasedDigital?: boolean;
    identifier?: string;
    url?: string;
    slug?: string;
    // TMDB-specific metadata
    listId?: string;
    listDescription?: string;
    mediatype?: string;
    traktEndpoint?: string;
    countrySlug?: string;
    discover?: {
      version?: number;
      source?: 'tmdb' | 'tvdb' | 'anilist' | 'simkl' | 'mal' | 'mdblist';
      mediaType?: 'movie' | 'tv' | 'series' | 'anime';
      params?: Record<string, string | number | boolean>;
      formState?: Record<string, any>;
    };
    discoverParams?: Record<string, string | number | boolean>;
    // Simkl-specific metadata
    interval?: 'today' | 'week' | 'month';
    pageSize?: number; // Results per page for Simkl trending and watchlist catalogs (default: 50)
    status?: 'watching' | 'plantowatch' | 'hold' | 'completed' | 'dropped'; // Status for Simkl watchlist catalogs
    /** Source references for merged catalogs (id starts with 'merged.') */
    mergedSources?: Array<{
      catalogId: string;       // source catalog id, e.g. "tmdb.top"
      catalogType: string;     // source catalog type at merge time
      originalEnabled: boolean;
      originalShowInHome: boolean;
    }>;
    mergeMode?: 'interleaved' | 'sequential' | 'alternating';
    // MovieLens-specific metadata
    sortBy?: string;
    sortDirection?: string;
    tags?: string;
    minYear?: number;
    maxYear?: number;
    minPop?: number;
    maxDaysAgo?: number;
    maxFutureDays?: number;
    includeRated?: boolean;
    listUserId?: number | string;
  };
}

export interface SearchConfig {
    id: string;
    name: string;
    type: 'movie' | 'series' | 'anime';
    enabled: boolean;
}

export type WatchTrackingService =
  | 'trakt'
  | 'simkl'
  | 'anilist'
  | 'mal'
  | 'mdblist'
  | 'publicmetadb';

export interface WatchTrackingMediaTypes {
  movie?: boolean;
  series?: boolean;
}

export type WatchTrackingConfig = Partial<
  Record<WatchTrackingService, WatchTrackingMediaTypes>
>;

export interface AppConfig {
  language: string;
  addonName: string;
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
    originalLangFallback: boolean;
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
    openrouter: string;
    traktTokenId?: string;
    simklTokenId?: string;
    anilistTokenId?: string;
    malTokenId?: string;
    movieLensCredId?: string;
    publicmetadb?: string;
    customDescriptionBlurb?: string;
  };
  /** Addon manager integrations (AIOManager, etc.) for syncing the addon into the user's manager, keyed by manager id */
  managers?: Record<string, {
    instanceUrl?: string;
    apiKey?: string;
  }>;
  /** Poster rating provider: 'none' to disable rating posters, 'rpdb' for RatingPosterDB, 'top' for Top Poster API, or 'custom' for custom URL patterns */
  /** Trailer source: 'default' uses the metadata provider's trailers, otherwise a Stremio addon supplies them */
  trailerProvider?: 'default' | 'streailer' | 'custom';
  trailerAddonUrl?: string;
  posterRatingProvider?: 'none' | 'rpdb' | 'top' | 'custom';
  usePosterProxy: boolean;
  mdblistWatchTracking: boolean;
  anilistWatchTracking: boolean;
  malWatchTracking?: boolean;
  simklWatchTracking: boolean;
  traktWatchTracking: boolean;
  publicmetadbWatchTracking: boolean;
  /** Optional per-service filters. Missing media-type flags preserve legacy behavior and are treated as enabled. */
  watchTracking?: WatchTrackingConfig;
  /** If true, keep RPDB posters for items in Continue Watching and Library (default: true). When disabled, RPDB posters are removed since catalog context is unavailable. */
  enableRatingPostersForLibrary?: boolean;
  /** If true, display a "⭐ Rate Me" genre button in meta pages that links to the rating page */
  showRateMeButton?: boolean;
  ageRating: string;
  sfw: boolean;
  hideUnreleasedDigital: boolean;
  hideUnreleasedDigitalSearch: boolean;
  hideUnreleasedShows: boolean;
  hideUnreleasedShowsSearch: boolean;
  hideWatchedTrakt?: boolean;
  hideWatchedAnilist?: boolean;
  hideWatchedMdblist?: boolean;
  hideWatchedSimkl?: boolean;
  exclusionKeywords?: string;
  regexExclusionFilter?: string;
  exclusionGenres?: string;
  catalogSetupComplete?: boolean;
  // AI Catalog Builder model, per provider. Unset falls back to the AI search
  // model when its provider matches, then to the provider default.
  ai_catalog?: {
    gemini_model?: string;
    openrouter_model?: string;
  };
  searchEnabled: boolean;
  sessionId: string;
  timezone?: string;
  catalogs: CatalogConfig[];
  deletedCatalogs?: string[];
  /** Collections and rows built in the Collections editor, exported as Nuvio or Fusion JSON */
  collections?: BuilderEntry[];
  search: {
    enabled: boolean; 
    // This is the switch for the AI layer.
    ai_enabled: boolean; 
    // This stores the primary keyword engine for each type.
    providers: {
        movie: 'tmdb.search' | 'tvdb.search' | 'trakt.search' | 'mdblist.search' | 'imdb.suggestions.search' | 'simkl.search';
        series: 'tmdb.search' | 'tvdb.search' | 'tvmaze.search' | 'trakt.search' | 'mdblist.search' | 'imdb.suggestions.search' | 'simkl.search';
        anime_movie: 'mal.search.movie' | 'kitsu.search.movie' | 'simkl.search.movie';
        anime_series: 'mal.search.series' | 'kitsu.search.series' | 'simkl.search.series';
        people_search_movie?: 'tmdb.people.search' | 'tvdb.people.search' | 'trakt.people.search';
        people_search_series?: 'tmdb.people.search' | 'tvdb.people.search' | 'trakt.people.search';
    };
    // New: per-engine enable/disable
    engineEnabled?: {
      [engine: string]: boolean;
    };
    // AI search provider and model
    ai_provider?: 'gemini' | 'openrouter';
    ai_model?: string;
    // Gemini google_search grounding tool. Off unless set.
    ai_web_search?: boolean;
    // OpenRouter :online suffix. On unless set to false.
    ai_openrouter_web_search?: boolean;
    // Optional keyword that must prefix a query for AI search to run. Blank = always run.
    // Only affects the AI catalog; regular search catalogs always see the original query.
    ai_trigger_keyword?: string;
    // RPDB enable/disable per search engine
    engineRatingPosters?: {
      [engine: string]: boolean;
    };
    // Custom names for search types (movie, series, anime_series, anime_movie, etc.)
    searchNames?: {
      [searchType: string]: string;
    };
    // Custom display types for search catalogs (overrides the default type in manifest)
    searchDisplayTypes?: {
      [searchType: string]: string;
    };
    // Order of search catalogs
    searchOrder?: string[];
  };
  streaming: string[];
  displayTypeOverrides?: {
    movie?: string;
    series?: string;
  };
  showDisabledCatalogs?: boolean;
  tags?: TagDef[];
  catalogModeOnly?: boolean;
  hideStremioCatalogs?: boolean;
  customPosterUrlPattern?: string;
  customBackgroundUrlPattern?: string;
  customLandscapeUrlPattern?: string;
  customLogoUrlPattern?: string;
  customThumbnailUrlPattern?: string;
}
