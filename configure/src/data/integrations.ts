export interface IntegrationDefinition {
  id: string;
  name: string;
  icon: string;
  description: string;
}

export const integrations: IntegrationDefinition[] = [
  {
    id: 'tmdb',
    name: 'TMDB',
    icon: 'https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg',
    description: 'Movie and series catalogs powered by The Movie Database.',
  },
  {
    id: 'tvdb',
    name: 'TVDB',
    icon: 'https://thetvdb.com/images/logo.svg',
    description: 'TVDB-backed metadata, collections, and discovery catalogs.',
  },
  {
    id: 'mal',
    name: 'MyAnimeList',
    icon: 'https://cdn.myanimelist.net/images/mal-logo-xsmall.png',
    description: 'Anime catalogs and search powered by MyAnimeList.',
  },
  {
    id: 'anilist',
    name: 'AniList',
    icon: 'https://anilist.co/img/icons/icon.svg',
    description: 'AniList integration for anime lists, discovery, and watch tracking.',
  },
  {
    id: 'trakt',
    name: 'Trakt',
    icon: 'https://walter.trakt.tv/images/poster-dark.8f923497.png',
    description: 'Sync Trakt auth, lists, watchlists, and trending catalogs.',
  },
  {
    id: 'mdblist',
    name: 'MDBList',
    icon: 'https://mdblist.com/favicon.ico',
    description: 'Import curated MDBList lists and external list catalogs.',
  },
  {
    id: 'letterboxd',
    name: 'Letterboxd',
    icon: 'https://letterboxd.com/static/img/apple-touch-icon.png',
    description: 'Add Letterboxd lists and watchlists as catalogs.',
  },
  {
    id: 'simkl',
    name: 'Simkl',
    icon: 'https://simkl.in/favicons/favicon-32x32.png',
    description: 'Simkl discovery, trending, and watchlist catalogs.',
  },
  {
    id: 'streaming',
    name: 'Streaming',
    icon: 'https://images.justwatch.com/icon/207360008/s100',
    description: 'Country-filtered streaming provider catalogs.',
  },
  {
    id: 'flixpatrol',
    name: 'FlixPatrol',
    icon: 'https://flixpatrol.com/favicon.ico',
    description: 'Streaming Top 10 charts sourced from FlixPatrol.',
  },
  {
    id: 'custom',
    name: 'Custom Manifest',
    icon: '/default.svg',
    description: 'Import catalogs from external addon manifests.',
  },
];
