// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export interface FeaturedCollection {
  id: string;
  name: string;
  author: string;
  authorUrl: string;
  /**
   * Fetched as-is. A remote URL keeps the author's own updates flowing without a
   * release here; a local one under public/featured pins a copy when the author
   * has no stable raw link to point at.
   */
  url: string;
  summary: string;
  note?: string;
  /** Shown before loading, because a big design can exceed the catalog limit. */
  catalogs: number;
  detail: string;
  /** Nuvio has no classic row and skips them, so the count is worth stating. */
  classicRows?: number;
}

export const FEATURED_COLLECTIONS: FeaturedCollection[] = [
  {
    id: 'anime-essentials',
    name: 'Anime Essentials',
    author: 'Cedya',
    authorUrl: 'https://github.com/cedya77',
    url: '/featured/anime-essentials.json',
    summary: 'Airing now and trending on AniList, your watchlist with upcoming, trending and popular picks, twenty-seven studios as cards and as logos, every MAL genre and theme, and five decades.',
    note: 'The Watchlist tile reads your own MDBList watchlist and AniList Watching list. The studio, genre and decade cards are Jeor\'s, from jeor.github.io/Anime. The studio logos come from Wikimedia Commons.',
    catalogs: 21,
    detail: '5 collections and 2 classic rows, 141 tiles with artwork.',
    classicRows: 2,
  },
  {
    id: 'starter-kit',
    name: 'Starter Kit',
    author: 'Renoria',
    authorUrl: 'https://kit.betterer.cc/',
    url: '/featured/starter-kit.json',
    summary: 'Awards, decades back to the 1930s, directors, genres in four styles and streaming services in five, every tile a folder.',
    note: 'Rebuilt on our own sources: each Trakt list is its curator\'s MDBList list or a close stand-in, a few come from Letterboxd, and the oldest decades and four services are TMDB Discover catalogs.',
    catalogs: 140,
    detail: '18 collections, 253 tiles with artwork.',
  },
  {
    id: 'ninja-streams',
    name: 'Ninja Streams',
    author: 'RandomNinjaAtk',
    authorUrl: 'https://github.com/RandomNinjaAtk/Ninja-Streams',
    url: 'https://raw.githubusercontent.com/RandomNinjaAtk/Ninja-Streams/main/AIOMetadata/Fusion-Widgets.json',
    summary: 'New and trending, streaming services, genres, decades, runtime, studios and networks, plus airing this week, recent releases and library rows.',
    catalogs: 114,
    detail: '12 designs, 7 collections and 5 classic rows.',
    classicRows: 5,
  },
  {
    id: 'callandt95',
    name: 'Callandt95',
    author: 'Callandt',
    authorUrl: 'https://github.com/itsrenoria/fusion-starter-kit',
    url: '/featured/callandt95.json',
    summary: 'Trending and watchlist rows, the latest on seven streaming services, seventeen movie genres and thirty film franchises.',
    note: 'Rebuilt on our own sources: the Trakt rows are the same curator\'s MDBList lists, the genre tiles are TMDB Discover catalogs, and the franchises are TMDB collections.',
    catalogs: 63,
    detail: '2 collections and 13 classic rows, 47 tiles with artwork.',
    classicRows: 13,
  },
  {
    id: 'snoak',
    name: 'Snoak',
    author: 'snoak',
    authorUrl: 'https://github.com/itsrenoria/fusion-starter-kit',
    url: '/featured/snoak.json',
    summary: 'Today\'s most popular, discover, the top ten on six streaming services, then those services and nine genres each with their latest and popular, and six decades.',
    note: 'Every row is the curator\'s own MDBList list, the same ones behind the Trakt design.',
    catalogs: 85,
    detail: '4 collections and 14 classic rows, 26 tiles with artwork.',
    classicRows: 14,
  },
  {
    id: 'tvgenie',
    name: 'TVGenie',
    author: 'tvgeniekodi',
    authorUrl: 'https://mdblist.com/lists/tvgeniekodi',
    url: '/featured/tvgenie.json',
    summary: 'Daily picks, latest and trending, the top of each decade from the 1980s and a few genres for movies and shows, and seven streaming networks.',
    note: 'Every tile is the curator\'s own MDBList list.',
    catalogs: 30,
    detail: '3 collections, 23 tiles with artwork.',
  },
  {
    id: 'ume-nobnobz',
    name: 'Unified Media Experience',
    author: 'nobnobz',
    authorUrl: 'https://nobnobz.github.io/fusion-widget-manager/',
    url: '/featured/ume-nobnobz.json',
    summary: 'Discover, streaming services, genres, decades, directors, actors, studios, awards, collections and lists.',
    catalogs: 371,
    detail: '24 designs, 10 collections and 14 classic rows, 271 folders with artwork.',
    classicRows: 14,
  },
];

export interface ArtworkResource {
  id: string;
  name: string;
  author: string;
  url: string;
  summary: string;
  tags: string[];
  images: string[];
  accent: string;
}

export const ARTWORK_RESOURCES: ArtworkResource[] = [
  {
    id: 'jeor-anime',
    name: 'Anime Card Collection',
    author: 'Jeor',
    url: 'https://jeor.github.io/Anime/',
    summary: 'Wide cards for anime studios, every genre and theme, decades, trending and popular, many with an alternate design.',
    tags: ['Wide', 'Studios', 'Genres', 'Decades'],
    images: [
      'https://jeor.github.io/Anime/previews/14-sci-fi.jpg',
      'https://jeor.github.io/Anime/previews/studios/studio-ghibli.jpg',
      'https://jeor.github.io/Anime/previews/studios/mappa.jpg',
    ],
    accent: 'from-violet-500/25 via-fuchsia-500/10',
  },
  {
    id: 'grainy-covers',
    name: 'Minimalist Covers',
    author: 'grainy',
    url: 'https://grainy.works/covers/',
    summary: 'Soft grain gradients for streaming services, genres, decades, anime and Letterboxd lists, in vertical and horizontal, with downloadable packs.',
    tags: ['Vertical', 'Horizontal', 'Anime', 'Packs'],
    images: [
      'https://grainy.works/covers/img/row3-1.jpg',
      'https://grainy.works/covers/img/row2-1.jpg',
      'https://grainy.works/covers/img/row2-2.jpg',
    ],
    accent: 'from-amber-400/25 via-rose-500/10',
  },
  {
    id: 'betterer-covers',
    name: 'betterer covers',
    author: 'Renoria',
    url: 'https://dev.betterer.cc/',
    summary: 'A cover maker: choose a layout, pick your colors and artwork, and export a cover for any movie or TV collection.',
    tags: ['Cover maker', 'Your colors', 'Movies & TV'],
    images: ['https://dev.betterer.cc/social/preview-2-1.jpg'],
    accent: 'from-sky-500/25 via-indigo-500/10',
  },
];
