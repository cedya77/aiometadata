interface CatalogDefinition {
  id: string;
  name: string;
  type: 'movie' | 'series' | 'anime';
  source: 'tmdb' | 'tvdb' | 'mal' | 'tvmaze' | 'mdblist' | 'streaming' | 'stremthru' | 'custom'; 
  isEnabledByDefault?: boolean;
  showOnHomeByDefault?: boolean;
}

// --- Catalogs sourced from TMDB and TVDB ---
export const baseCatalogs: CatalogDefinition[] = [
  { id: 'tmdb.top', name: 'TMDB Popular', type: 'movie', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.top', name: 'TMDB Popular', type: 'series', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.trending', name: 'TMDB Trending', type: 'movie', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.trending', name: 'TMDB Trending', type: 'series', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.top_rated', name: 'TMDB Top Rated', type: 'movie', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.top_rated', name: 'TMDB Top Rated', type: 'series', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.airing_today', name: 'TMDB Airing Today', type: 'series', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.year', name: 'TMDB By Year', type: 'movie', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tmdb.year', name: 'TMDB By Year', type: 'series', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tmdb.language', name: 'TMDB By Language', type: 'movie', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tmdb.language', name: 'TMDB By Language', type: 'series', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tvdb.trending', name: 'TVDB Trending', type: 'movie', source: 'tvdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tvdb.trending', name: 'TVDB Trending', type: 'series', source: 'tvdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tvdb.genres', name: 'TVDB Genres', type: 'movie', source: 'tvdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tvdb.genres', name: 'TVDB Genres', type: 'series', source: 'tvdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tvdb.collections', name: 'TVDB Collections', type: 'movie', source: 'tvdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tvmaze.schedule', name: 'TVmaze Daily Schedule', type: 'series', source: 'tvmaze', isEnabledByDefault: true, showOnHomeByDefault: true },
];

// --- Catalogs sourced from MyAnimeList ---
export const animeCatalogs: CatalogDefinition[] = [
  { id: 'mal.airing', name: 'MAL Airing Now', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.upcoming', name: 'MAL Upcoming Season', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.schedule', name: 'MAL Airing Schedule', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'mal.seasons', name: 'MAL Seasons', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'mal.80sDecade', name: 'MAL Best of 80s', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.90sDecade', name: 'MAL Best of 90s', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.00sDecade', name: 'MAL Best of 2000s', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.10sDecade', name: 'MAL Best of 2010s', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.20sDecade', name: 'MAL Best of 2020s', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.genres', name: 'MAL Genres', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: false }, 
  { id: 'mal.studios', name: 'MAL By Studio', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'mal.top_movies', name: 'MAL Top Movies', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.top_series', name: 'MAL Top Series', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.most_favorites', name: 'MAL Most Favorites', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.most_popular', name: 'MAL Most Popular', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.top_anime', name: 'MAL Top Anime', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
]

// --- Catalogs requiring Authentication ---
// Note: TMDB watchlist and favorites are now managed through the TMDB Integration dialog
// (similar to how Trakt watchlist and favorites are managed)
export const authCatalogs: CatalogDefinition[] = [];

import { streamingServices, regions } from "./streamings";

interface StreamingCatalogDefinition extends CatalogDefinition {
  regions: string[];
  icon: string;
}

export const streamingCatalogs: StreamingCatalogDefinition[] = streamingServices.flatMap(service => [
  {
    id: `streaming.${service.id}`,
    name: `${service.name} (Movies)` ,
    type: 'movie',
    source: 'streaming',
    isEnabledByDefault: false,
    showOnHomeByDefault: false,
    regions: Object.entries(regions)
      .filter(([country, ids]) => ids.includes(service.id))
      .map(([country]) => country),
    icon: service.icon
  },
  {
    id: `streaming.${service.id}`,
    name: `${service.name} (Series)` ,
    type: 'series',
    source: 'streaming',
    isEnabledByDefault: false,
    showOnHomeByDefault: false,
    regions: Object.entries(regions)
      .filter(([country, ids]) => ids.includes(service.id))
      .map(([country]) => country),
    icon: service.icon
  }
]);

interface SearchProviderDefinition {
  // Let's adjust this slightly to make filtering easier
  value: string;
  label: string;
  // This helps us know which dropdown to put it in
  mediaType: ('movie' | 'series' | 'anime_movie' | 'anime_series')[];
}

export const allSearchProviders: SearchProviderDefinition[] = [
  // Generic Providers
  { value: 'tmdb.search', label: 'TMDB Search', mediaType: ['movie', 'series'] },
  { value: 'tvdb.search', label: 'TheTVDB Search', mediaType: ['movie', 'series'] },
  { value: 'tvmaze.search', label: 'TVmaze Search', mediaType: ['series'] },
  { value: 'trakt.search', label: 'Trakt Search', mediaType: ['movie', 'series'] },
  { value: 'mdblist.search', label: 'MDBList Search', mediaType: ['movie', 'series'] },
  // People Search Providers
  { value: 'tmdb.people.search', label: 'TMDB People Search', mediaType: ['movie', 'series'] },
  { value: 'tvdb.people.search', label: 'TheTVDB People Search', mediaType: ['movie', 'series'] },
  { value: 'trakt.people.search', label: 'Trakt People Search', mediaType: ['movie', 'series'] },

  // Anime-Specific Providers
  { value: 'mal.search.movie', label: 'MAL (Movies)', mediaType: ['movie', 'anime_movie'] },
  { value: 'mal.search.series', label: 'MAL (Series)', mediaType: ['series', 'anime_series'] },
  { value: 'kitsu.search.movie', label: 'Kitsu (Movies)', mediaType: ['movie', 'anime_movie'] },
  { value: 'kitsu.search.series', label: 'Kitsu (Series)', mediaType: ['series', 'anime_series'] },
];

export const allCatalogDefinitions: CatalogDefinition[] = [
  ...baseCatalogs,
  ...animeCatalogs,
  ...authCatalogs,
  ...streamingCatalogs.map(({ regions, icon, ...rest }) => rest),
]; 
