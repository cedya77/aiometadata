// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
export const TMDB_IMAGE_HOST = 'https://image.tmdb.org/t/p';

export const TMDB_POSTER_SIZE = 'w600_and_h900_bestv2';

const ORIGINAL = 'original';
const SMALL_LOGO = 'w500';
const SMALL_BACKDROP = 'w1280';
const SMALL_LANDSCAPE = 'w780';

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value || '').trim());
}

function isExplicitlyDisabled(value: string | undefined): boolean {
  return /^(0|false|no|off)$/i.test((value || '').trim());
}

function requestSize(nativeWidth: number | undefined, target: number, sized: string): string {
  const known = typeof nativeWidth === 'number' && nativeWidth > 0;
  return known && nativeWidth <= target ? ORIGINAL : sized;
}

// On by default, unlike the other three
export function tmdbPosterSize(): string {
  return isExplicitlyDisabled(process.env.PREFER_SMALLER_POSTERS_TMDB) ? ORIGINAL : TMDB_POSTER_SIZE;
}

export function tmdbLogoSize(nativeWidth?: number): string {
  if (!isTruthy(process.env.PREFER_SMALLER_LOGOS_TMDB)) return ORIGINAL;
  return requestSize(nativeWidth, 500, SMALL_LOGO);
}

export function tmdbBackdropSize(nativeWidth?: number): string {
  if (!isTruthy(process.env.PREFER_SMALLER_BACKDROPS_TMDB)) return ORIGINAL;
  return requestSize(nativeWidth, 1280, SMALL_BACKDROP);
}

export function tmdbLandscapeSize(nativeWidth?: number): string {
  if (!isTruthy(process.env.PREFER_SMALLER_LANDSCAPE_TMDB)) return ORIGINAL;
  return requestSize(nativeWidth, 780, SMALL_LANDSCAPE);
}

export function tmdbImageUrl(size: string, filePath: string): string {
  return `${TMDB_IMAGE_HOST}/${size}${filePath}`;
}

module.exports = {
  TMDB_IMAGE_HOST,
  TMDB_POSTER_SIZE,
  tmdbPosterSize,
  tmdbLogoSize,
  tmdbBackdropSize,
  tmdbLandscapeSize,
  tmdbImageUrl,
};
