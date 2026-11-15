// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/**
 * The id vocabulary a meta can carry. Prefixed ids live in `meta.id`, and the
 * providers also hang their own resolved ids off `_`-prefixed properties.
 * `id` is the meta's own id exactly as served (e.g. `mal:16498`, `tt0111161`),
 * with no prefix stripped; custom art patterns expose it as `{id}`.
 */
export interface MetaIds {
  id?: string;
  imdbId?: string;
  tmdbId?: string;
  tvdbId?: string;
  kitsuId?: string;
  malId?: string;
  anilistId?: string;
  anidbId?: string;
}

export function extractIdsFromMeta(meta: any): MetaIds {
  const ids: MetaIds = {};
  if (!meta) return ids;

  const id = meta.id || '';
  if (id) ids.id = id;
  if (id.startsWith('tmdb:')) ids.tmdbId = id.slice(5);
  else if (id.startsWith('tvdb:')) ids.tvdbId = id.slice(5);
  else if (id.startsWith('kitsu:')) ids.kitsuId = id.slice(6);
  else if (id.startsWith('mal:')) ids.malId = id.slice(4);
  else if (id.startsWith('anilist:')) ids.anilistId = id.slice(8);
  else if (id.startsWith('anidb:')) ids.anidbId = id.slice(6);
  else if (id.startsWith('tt')) ids.imdbId = id;

  // Pick up additional IDs from meta properties
  if (meta.imdb_id) ids.imdbId = meta.imdb_id;
  if (meta._tmdbId && !ids.tmdbId) ids.tmdbId = meta._tmdbId;
  if (meta._tvdbId && !ids.tvdbId) ids.tvdbId = meta._tvdbId;
  if (meta._imdbId && !ids.imdbId) ids.imdbId = meta._imdbId;
  if (meta._malId && !ids.malId) ids.malId = meta._malId;
  if (meta._kitsuId && !ids.kitsuId) ids.kitsuId = meta._kitsuId;
  if (meta._anilistId && !ids.anilistId) ids.anilistId = meta._anilistId;
  if (meta._anidbId && !ids.anidbId) ids.anidbId = meta._anidbId;

  return ids;
}

/**
 * Up-next rows synthesise ids like `upnext_tt0903747_S03E07`. Recover the show
 * id from one, so a meta request for a row lands on the real title.
 */
export function extractCanonicalIdFromDynamicUpNextId(type: string, stremioId: string): string | null {
  if (type !== 'series' || typeof stremioId !== 'string') {
    return null;
  }

  const prefixes = ['mdblist_upnext_', 'simkl_upnext_', 'pmdb_resume_', 'upnext_'];
  const prefix = prefixes.find(p => stremioId.startsWith(p));
  if (!prefix) {
    return null;
  }

  const remainder = stremioId.slice(prefix.length);
  const episodeSeparatorIndex = remainder.lastIndexOf('_');
  if (episodeSeparatorIndex <= 0) {
    return null;
  }

  const canonicalId = remainder.slice(0, episodeSeparatorIndex);
  const episodePart = remainder.slice(episodeSeparatorIndex + 1);
  const isSupportedCanonicalId = /^tt\d+$/.test(canonicalId) ||
    /^tmdb:\d+$/.test(canonicalId) ||
    /^tvdb:\d+$/.test(canonicalId);
  const isSupportedEpisodePart = /^trakt\d+$/.test(episodePart) ||
    /^S\d+E\d+$/.test(episodePart) ||
    episodePart === 'unknown';

  return isSupportedCanonicalId && isSupportedEpisodePart ? canonicalId : null;
}
