export interface CatalogConfig {
  id: string;
  name: string;
  type: 'movie' | 'series' | 'anime';
  enabled: boolean;
  source: 'tmdb' | 'tvdb' | 'mal' | 'tvmaze' | 'mdblist' | 'streaming' | 'stremthru'; // Keep source as the display label
  sourceUrl?: string; // Store the actual URL for StremThru catalogs
  showInHome: boolean;
  genres?: string[]; // Optional genres array for catalogs that support genre filtering
  manifestData?: any; // Store original manifest data for advanced features like skip support
  manifestUrl?: string; // Original StremThru manifest URL (for updating/tracking)
  manifestId?: string; // Unique manifest identifier for grouping
  manifestName?: string; // Human-readable manifest name
  // MDBList sorting options
  sort?: 'rank' | 'score' | 'usort' | 'score_average' | 'released' | 'releasedigital' | 'imdbrating' | 'imdbvotes' | 'last_air_date' | 'imdbpopular' | 'tmdbpopular' | 'rogerbert' | 'rtomatoes' | 'rtaudience' | 'metacritic' | 'myanimelist' | 'letterrating' | 'lettervotes' | 'budget' | 'revenue' | 'runtime' | 'title' | 'added' | 'random' | 'default';
  order?: 'asc' | 'desc';
  // Custom cache TTL for MDBList catalogs (in seconds, defaults to 24 hours)
  cacheTTL?: number;
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
  };
  apiKeys: {
    gemini: string;
    tmdb: string;
    tvdb: string;
    fanart: string;
    rpdb: string;
    mdblist: string;
  };
  ageRating: string;
  sfw: boolean;
  hideUnreleasedDigital: boolean;
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
        anime_movie: string;
        anime_series: string;
    };
    // New: per-engine enable/disable
    engineEnabled?: {
      [engine: string]: boolean;
    };
  };
  streaming: string[];
}
