// SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
// Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
/** Stamps `_listedAt` on catalog metas from the list entries they were built from, matched on any id both carry. */
export function stampListedAt(metas: any[], entries: any[], idsOf: (entry: any) => Record<string, any>, dateOf: (entry: any) => any): any[] {
  const byId = new Map<string, string>();
  for (const entry of entries) {
    const at = dateOf(entry);
    const iso = at ? new Date(at).toISOString() : null;
    if (!iso || iso === 'Invalid Date') continue;
    const ids = idsOf(entry) || {};
    for (const [key, value] of Object.entries(ids)) {
      if (value === null || value === undefined || value === '') continue;
      byId.set(`${key}:${String(value)}`, iso);
    }
  }
  if (!byId.size) return metas;
  return metas.map((meta: any) => {
    if (!meta) return meta;
    const own = [
      meta.id?.startsWith?.('tt') ? `imdb:${meta.id}` : null,
      meta._imdbId ? `imdb:${meta._imdbId}` : null,
      meta._tmdbId ? `tmdb:${meta._tmdbId}` : null,
      meta._tvdbId ? `tvdb:${meta._tvdbId}` : null,
      meta._kitsuId ? `kitsu:${meta._kitsuId}` : null,
      meta._malId ? `mal:${meta._malId}` : null,
      meta.id?.startsWith?.('kitsu:') ? `kitsu:${meta.id.slice(6)}` : null,
      meta.id?.startsWith?.('mal:') ? `mal:${meta.id.slice(4)}` : null,
      meta.id?.startsWith?.('tmdb:') ? `tmdb:${meta.id.slice(5)}` : null,
      meta.id?.startsWith?.('tvdb:') ? `tvdb:${meta.id.slice(5)}` : null,
    ].filter(Boolean) as string[];
    const at = own.map((k) => byId.get(k)).find(Boolean);
    return at ? { ...meta, _listedAt: at } : meta;
  });
}
