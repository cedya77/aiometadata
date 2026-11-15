// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { AppConfig, CatalogConfig } from '@/contexts/config';

export type ContentChoice = 'movies-tv' | 'with-anime' | 'anime-first';

export type AnimeSource = 'tvdb' | 'kitsu' | 'imdb';

export type LineupKind = 'minimal' | 'balanced' | 'everything';

export type RequiredKeyId = 'tmdb' | 'tvdb' | 'mdblist';

export interface ConfigTemplate {
  id: string;
  name: string;
  tagline: string;
  lineup: LineupKind | { catalogIds: string[] };
  catalogs?: CatalogConfig[];
  settings?: Partial<AppConfig>;
  requires?: RequiredKeyId[];
  source?: { kind: 'builtin' } | { kind: 'imported'; url?: string; importedAt: string };
}

export interface SetupExtras {
  streamingCatalogs?: CatalogConfig[];
  curatorCatalogs?: CatalogConfig[];
  aiCatalogs?: CatalogConfig[];
  /** Absent entries are left untouched rather than blanked. */
  apiKeys?: Partial<Record<RequiredKeyId, string>>;
}
