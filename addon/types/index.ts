// Core type definitions for the AIOMetadata backend

export interface UserConfig {
  language?: string;
  providers?: {
    movie?: string;
    series?: string;
    anime?: string;
  };
  artProviders?: {
    movie?: string;
    series?: string;
    anime?: string;
  };
  apiKeys?: {
    tmdb?: string;
    tvdb?: string;
    fanart?: string;
    rpdb?: string;
    topPoster?: string;
    mdblist?: string;
    gemini?: string;
    imdb?: string;
    traktTokenId?: string;
  };
  /** Poster rating provider: 'rpdb' for RatingPosterDB or 'top' for Top Poster API */
  posterRatingProvider?: 'rpdb' | 'top';
  catalogs?: Catalog[];
  streaming?: StreamingConfig[];
  mal?: {
    enabled?: boolean;
    [key: string]: any;
  };
  sfw?: boolean;
  includeAdult?: boolean;
  ageRating?: string;
  hideUnreleasedDigital?: boolean;
  exclusionKeywords?: string;
  regexExclusionFilter?: string;
  tvdbSeasonType?: string;
  castCount?: number;
  blurThumbs?: boolean;
  displayAgeRating?: boolean;
  configVersion?: number;
  userUUID?: string;
  sessionId?: string;
  timezone?: string;
  [key: string]: any;
}

export interface Catalog {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  showInHome: boolean;
  source?: string;
  randomizePerPage?: boolean;
  [key: string]: any;
}

export interface StreamingConfig {
  provider: string;
  region: string;
  enabled: boolean;
  [key: string]: any;
}

export interface MetaData {
  id: string;
  type: string;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string[];
  cast?: any[];
  director?: string[];
  imdbRating?: string;
  [key: string]: any;
}

export interface CatalogResponse {
  metas: MetaData[];
  hasMore?: boolean;
  [key: string]: any;
}

export interface SearchResponse {
  metas: MetaData[];
  hasMore?: boolean;
  [key: string]: any;
}

export interface CacheOptions {
  enableErrorCaching?: boolean;
  maxRetries?: number;
  [key: string]: any;
}

export interface DatabaseUser {
  uuid: string;
  config: UserConfig;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface IdMapping {
  tmdbId?: string;
  tvdbId?: string;
  imdbId?: string;
  malId?: string;
  anilistId?: string;
  kitsuId?: string;
  anidbId?: string;
  tvmazeId?: string;
  [key: string]: any;
}

export interface AnimeData {
  malId?: string;
  anilistId?: string;
  kitsuId?: string;
  anidbId?: string;
  title?: string;
  type?: string;
  episodes?: number;
  status?: string;
  [key: string]: any;
}

export interface RequestContext {
  userUUID?: string;
  userConfig?: UserConfig;
  [key: string]: any;
}

// Express request extension
export interface AuthenticatedRequest extends Express.Request {
  userConfig?: UserConfig;
  userUUID?: string;
  params: any;
  route?: any;
  headers: any;
}

// Environment variables
export interface EnvironmentConfig {
  PORT?: string;
  TMDB_API?: string;
  TVDB_API_KEY?: string;
  FANART_API_KEY?: string;
  RPDB_API_KEY?: string;
  MDBLIST_API_KEY?: string;
  GEMINI_API_KEY?: string;
  DATABASE_URI?: string;
  REDIS_URL?: string;
  HOST_NAME?: string;
  NO_CACHE?: string;
  ENABLE_CACHE_WARMING?: string;
  CACHE_WARMING_INTERVAL?: string;
  ADDON_PASSWORD?: string;
  ADMIN_KEY?: string;
  [key: string]: string | undefined;
}
