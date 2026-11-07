type Pick = (metas: any[]) => Promise<any[]>;

/** A favourites request; a client with its own watchlist asks for it by likes. */
export function asksForFavourites(query: Record<string, unknown>, ownWatchlist: boolean): boolean {
  const filters = String(query.Filters ?? query.filters ?? '').split(',').map((f) => f.trim());
  const flag = String(query.IsFavorite ?? query.isFavorite ?? '').toLowerCase() === 'true';
  return filters.includes('IsFavorite') || filters.includes('IsFavoriteOrLikes') || flag || (ownWatchlist && filters.includes('Likes'));
}

/**
 * Catalogs report no total, so one page of lookahead keeps the client asking and collapses to the truth once the
 * catalog runs out. A filtered page the budget cut short stays open even when empty, since the next ask reads on.
 */
export function listTotal(startIndex: number, shown: number, pageLimit: number, window: { hasMore: boolean; truncated?: boolean }): number {
  return window.hasMore && (shown > 0 || window.truncated) ? startIndex + shown + pageLimit : startIndex + shown;
}

export function chainPicks(...picks: Array<Pick | undefined>): Pick | undefined {
  const present = picks.filter((pick): pick is Pick => typeof pick === 'function');
  if (present.length <= 1) return present[0];
  return async (metas: any[]) => {
    let kept = metas;
    for (const pick of present) {
      if (!kept.length) break;
      kept = await pick(kept);
    }
    return kept;
  };
}
