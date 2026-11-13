// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
const { getImdbRatingString, getImdbRatingStrings }: any = require('./imdbRatings');

const NO_RATING = 'N/A';

function imdbIdOf(meta: any): string | null {
  const direct = meta?.imdb_id || meta?._imdbId;
  if (typeof direct === 'string' && direct.startsWith('tt')) return direct;
  const fromId = typeof meta?.id === 'string' ? meta.id.match(/^tt\d+/)?.[0] : null;
  return fromId || null;
}

function setRating(meta: any, rating: string): void {
  meta.imdbRating = rating;
  if (Array.isArray(meta.links)) {
    meta.links = meta.links.map((link: any) =>
      link?.category === 'imdb' ? { ...link, name: rating } : link
    );
  }
}

/**
 * Resolved on the way out rather than baked into the cached payload: the ratings
 * dataset refreshes on its own interval, and a meta cached before a refresh would
 * otherwise serve the old figure until META_TTL expires.
 */
async function applyImdbRatingProjection(meta: any): Promise<any> {
  if (!meta) return meta;

  const imdbId = imdbIdOf(meta);
  if (!imdbId) return meta;

  setRating(meta, (await getImdbRatingString(imdbId)) || NO_RATING);
  return meta;
}

/** One batch for the page rather than a call per tile. */
async function applyImdbRatingProjectionToList(metas: any[]): Promise<any[]> {
  if (!Array.isArray(metas) || metas.length === 0) return metas;

  const ids = new Map<any, string>();
  for (const meta of metas) {
    if (!meta || typeof meta !== 'object') continue;
    const imdbId = imdbIdOf(meta);
    if (imdbId) ids.set(meta, imdbId);
  }
  if (ids.size === 0) return metas;

  const ratings = await getImdbRatingStrings([...ids.values()]);
  for (const [meta, imdbId] of ids) {
    setRating(meta, ratings.get(imdbId) || NO_RATING);
  }

  return metas;
}

export { applyImdbRatingProjection, applyImdbRatingProjectionToList, NO_RATING };
module.exports = { applyImdbRatingProjection, applyImdbRatingProjectionToList, NO_RATING };
