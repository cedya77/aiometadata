interface CatalogDefinition {
  id: string;
  name: string;
  type: 'movie' | 'series' | 'anime';
  source: 'tmdb' | 'tvdb' | 'mal' | 'tvmaze' | 'mdblist' | 'streaming'; 
  isEnabledByDefault?: boolean;
  showOnHomeByDefault?: boolean;
}

// --- Catalogs sourced from TMDB and TVDB ---
export const baseCatalogs: CatalogDefinition[] = [
  { id: 'tmdb.top', name: 'TMDB Popular Movies', type: 'movie', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.top', name: 'TMDB Popular Series', type: 'series', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.trending', name: 'TMDB Trending Movies', type: 'movie', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.trending', name: 'TMDB Trending Series', type: 'series', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'tmdb.year', name: 'TMDB By Year (Movies)', type: 'movie', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tmdb.year', name: 'TMDB By Year (Series)', type: 'series', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tmdb.language', name: 'TMDB By Language (Movies)', type: 'movie', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tmdb.language', name: 'TMDB By Language (Series)', type: 'series', source: 'tmdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tvdb.genres', name: 'TVDB Genres (Movies)', type: 'movie', source: 'tvdb', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'tvdb.genres', name: 'TVDB Genres (Series)', type: 'series', source: 'tvdb', isEnabledByDefault: true, showOnHomeByDefault: false },
];

// --- Catalogs sourced from MyAnimeList ---
export const animeCatalogs: CatalogDefinition[] = [
  { id: 'mal.airing', name: 'MAL Airing Now', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.upcoming', name: 'MAL Upcoming Season', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.schedule', name: 'MAL Airing Schedule', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: false },
  { id: 'mal.decade80s', name: 'MAL Best of 80s', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.decade90s', name: 'MAL Best of 90s', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.decade00s', name: 'MAL Best of 2000s', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.decade10s', name: 'MAL Best of 2010s', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.decade20s', name: 'MAL Best of 2020s', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: true },
  { id: 'mal.genres', name: 'MAL Genres', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: false }, 
  { id: 'mal.studios', name: 'MAL By Studio', type: 'anime', source: 'mal', isEnabledByDefault: true, showOnHomeByDefault: false },
]

// --- Catalogs requiring TMDB Authentication ---
export const authCatalogs: CatalogDefinition[] = [
    { id: 'tmdb.favorites', name: 'TMDB Favorites (Movies)', type: 'movie', source: 'tmdb', isEnabledByDefault: false, showOnHomeByDefault: false },
    { id: 'tmdb.favorites', name: 'TMDB Favorites (Series)', type: 'series', source: 'tmdb', isEnabledByDefault: false, showOnHomeByDefault: false },
    { id: 'tmdb.watchlist', name: 'TMDB Watchlist (Movies)', type: 'movie', source: 'tmdb', isEnabledByDefault: false, showOnHomeByDefault: false },
    { id: 'tmdb.watchlist', name: 'TMDB Watchlist (Series)', type: 'series', source: 'tmdb', isEnabledByDefault: false, showOnHomeByDefault: false },
];

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
  { value: 'tvdb.search', label: 'TheTVDB Search', mediaType: ['series'] },
  { value: 'tvmaze.search', label: 'TVmaze Search', mediaType: ['series'] },

  // Anime-Specific Providers
  { value: 'mal.search.movie', label: 'MAL Keyword (Movies)', mediaType: ['movie', 'anime_movie'] },
  { value: 'mal.search.series', label: 'MAL Keyword (Series)', mediaType: ['series', 'anime_series'] },
];

export const allCatalogDefinitions: CatalogDefinition[] = [
  ...baseCatalogs,
  ...animeCatalogs,
  ...authCatalogs,
  ...streamingCatalogs.map(({ regions, icon, ...rest }) => rest),
]; 
