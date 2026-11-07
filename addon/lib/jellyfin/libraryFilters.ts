type Pick = (metas: any[]) => Promise<any[]>;

/** A favourites request; a client with its own watchlist asks for it by likes. */
export function asksForFavourites(query: Record<string, unknown>, ownWatchlist: boolean): boolean {
  const filters = String(query.Filters ?? query.filters ?? '').split(',').map((f) => f.trim());
  const flag = String(query.IsFavorite ?? query.isFavorite ?? '').toLowerCase() === 'true';
  return filters.includes('IsFavorite') || filters.includes('IsFavoriteOrLikes') || flag || (ownWatchlist && filters.includes('Likes'));
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
