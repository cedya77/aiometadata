// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
// These lead their genre options with a real value, not 'None', when hidden from home.
const FIRST_OPTION_CATALOGS = new Set([
  'tmdb.trending',
  'tvdb.genres',
  'tvdb.trending',
  'mal.studios',
  'mal.schedule',
  'mal.seasons',
]);

const NONE_PREFIXES = [
  'mdblist.', 'trakt.', 'anilist.', 'letterboxd.', 'flixpatrol.', 'stremthru.', 'custom.',
  'streaming.', 'simkl.', 'movielens.', 'lumiere.', 'publicmetadb.', 'tmdb.discover', 'tmdb.collection.',
  'tvdb.discover', 'tvdb.list.', 'mal.',
];

const NONE_IDS = new Set(['tmdb.top', 'tvmaze.schedule', 'tmdb.airing_today', 'tmdb.top_rated']);

/**
 * Whether a catalog kept off the home screen offers 'None' as its first genre,
 * which a client following the manifest sends when it picks no genre. The
 * warmer warms that shape, so the route gives a client that leaves the genre
 * out the same one.
 */
export function defaultsToNoneGenre(catalogId: string): boolean {
  if (FIRST_OPTION_CATALOGS.has(catalogId)) return false;
  return NONE_IDS.has(catalogId) || NONE_PREFIXES.some((prefix) => catalogId.startsWith(prefix));
}

module.exports = { defaultsToNoneGenre };
