// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE


import type { AppConfig } from '../contexts/config';

export type ContentType = 'movie' | 'series' | 'anime';
export type ArtType = 'poster' | 'background' | 'logo';

export const CONTENT_TYPES: ContentType[] = ['movie', 'series', 'anime'];
export const ART_TYPES: ArtType[] = ['poster', 'background', 'logo'];

export interface ArtProviderOption {
  value: string;
  label: string;
  requiresKey?: 'tvdb';
}

type ArtProvidersConfig = Partial<AppConfig['artProviders']> & Record<string, unknown>;

const MOVIE_AND_SERIES: ArtProviderOption[] = [
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'tvdb', label: 'TheTVDB', requiresKey: 'tvdb' },
  { value: 'fanart', label: 'Fanart.tv' },
  { value: 'imdb', label: 'Internet Movie Database (IMDB/Cinemeta)' },
];

const ANIME_POSTER: ArtProviderOption[] = [
  { value: 'mal', label: 'MyAnimeList' },
  { value: 'anilist', label: 'AniList' },
  { value: 'kitsu', label: 'Kitsu' },
  { value: 'tvdb', label: 'TheTVDB', requiresKey: 'tvdb' },
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'fanart', label: 'Fanart.tv' },
  { value: 'imdb', label: 'Internet Movie Database (IMDB/Cinemeta)' },
];

const ANIME_BACKGROUND: ArtProviderOption[] = [
  { value: 'mal', label: 'MyAnimeList' },
  { value: 'anilist', label: 'AniList' },
  { value: 'kitsu', label: 'Kitsu' },
  { value: 'tvdb', label: 'TheTVDB', requiresKey: 'tvdb' },
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'fanart', label: 'Fanart.tv' },
  { value: 'imdb', label: 'Internet Movie Database (IMDB/Cinemeta) (Recommended)' },
];

const ANIME_LOGO: ArtProviderOption[] = [
  { value: 'imdb', label: 'Internet Movie Database (IMDB/Cinemeta) (Recommended)' },
  { value: 'tvdb', label: 'TheTVDB', requiresKey: 'tvdb' },
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'fanart', label: 'Fanart.tv' },
];

export function getOptions(contentType: ContentType, artType: ArtType): ArtProviderOption[] {
  if (contentType !== 'anime') return MOVIE_AND_SERIES;
  if (artType === 'background') return ANIME_BACKGROUND;
  if (artType === 'logo') return ANIME_LOGO;
  return ANIME_POSTER;
}

export function readValue(
  artProviders: ArtProvidersConfig | undefined,
  contentType: ContentType,
  artType: ArtType
): string {
  const entry = artProviders?.[contentType];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    return (entry as Record<ArtType, string>)[artType] || 'meta';
  }
  return 'meta';
}

export function writeValue(
  artProviders: ArtProvidersConfig | undefined,
  contentType: ContentType,
  artType: ArtType,
  value: string
): ArtProvidersConfig {
  const current = artProviders?.[contentType];
  const seeded: Record<ArtType, string> =
    typeof current === 'string'
      ? { poster: current, background: current, logo: current }
      : current && typeof current === 'object'
        ? { poster: 'meta', background: 'meta', logo: 'meta', ...(current as Record<ArtType, string>) }
        : { poster: 'meta', background: 'meta', logo: 'meta' };

  return {
    ...(artProviders || {}),
    [contentType]: { ...seeded, [artType]: value },
  };
}
