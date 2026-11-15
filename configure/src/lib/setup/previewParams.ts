// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
import type { AppConfig } from '@/contexts/config';

/** Mirrors buildParameters in addon/lib/getCatalog.ts. Keep in step with it. */
const MOVIE_CERTIFICATIONS: Record<string, string[]> = {
  G: ['G'],
  PG: ['G', 'PG'],
  'PG-13': ['G', 'PG', 'PG-13'],
  R: ['G', 'PG', 'PG-13', 'R'],
};

const SERIES_CERTIFICATIONS: Record<string, string[]> = {
  G: ['TV-Y', 'TV-Y7', 'TV-G'],
  PG: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG'],
  'PG-13': ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14'],
  R: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'],
};

export function tmdbPreviewParams(
  config: AppConfig,
  type: 'movie' | 'tv'
): Record<string, string> {
  const params: Record<string, string> = {
    type,
    language: config.language || 'en-US',
    include_adult: String(!!config.includeAdult),
    'vote_count.gte': '50',
  };

  const table = type === 'movie' ? MOVIE_CERTIFICATIONS : SERIES_CERTIFICATIONS;
  const allowed = config.ageRating ? table[config.ageRating] : undefined;
  if (allowed) {
    params.certification_country = 'US';
    params.certification = allowed.join('|');
  }

  return params;
}

export function malPreviewParams(config: AppConfig): Record<string, string> {
  return config.sfw ? { sfw: 'true' } : {};
}
