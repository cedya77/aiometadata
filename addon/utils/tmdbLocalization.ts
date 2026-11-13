// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * Whether a TMDB record's title and overview came back in the user's own language.
 * No imports on purpose: parseProps and getTmdb drag in the Redis cache stack, which
 * makes them unusable from a test. parseProps re-exports this for `Utils` callers.
 */

export type TmdbLocalizationStamp = {
  titleLang: 'exact' | 'fallback';
  overviewLang: 'exact' | 'fallback';
};

/** Mirrors getTmdb.getTranslations; keep the two in step. */
function findExactTranslation(translations: any, language: string): any {
  const list = translations?.translations;
  if (!Array.isArray(list)) return null;
  const [iso639, iso3166] = String(language).split('-');
  return list.find((t: any) => t?.iso_639_1 === iso639 && t?.iso_3166_1 === iso3166) || null;
}

export function classifyTmdbLocalization(
  rawData: any,
  language: string,
  type: 'movie' | 'series'
): TmdbLocalizationStamp {
  const titleField = type === 'movie' ? 'title' : 'name';
  const baseLang = String(language || 'en-US').split('-')[0].toLowerCase();
  const originalLang = String(rawData?.original_language || '').toLowerCase();

  const entry = findExactTranslation(rawData?.translations, language || 'en-US');
  const entryTitle = entry?.data?.[titleField];
  const hasLocalizedTitle = typeof entryTitle === 'string' && entryTitle.trim() !== '';

  const overview = rawData?.overview;
  const hasLocalizedOverview = typeof overview === 'string' && overview.trim() !== '';

  return {
    titleLang: hasLocalizedTitle || (!!originalLang && originalLang === baseLang) ? 'exact' : 'fallback',
    overviewLang: hasLocalizedOverview ? 'exact' : 'fallback',
  };
}

module.exports = { classifyTmdbLocalization };
