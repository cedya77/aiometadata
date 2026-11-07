import { namedItem, yearItemId } from './dto';

type Pick = (metas: any[]) => Promise<any[]>;

/** The ratings and years a page holds, each once, as filter menus list them. */
export function facetsOf(entries: Array<{ rating: string | null; year: number | null }>): { ratings: string[]; years: number[] } {
  const ratings = new Set<string>();
  const years = new Set<number>();
  for (const { rating, year } of entries) {
    if (rating) ratings.add(rating);
    if (Number.isInteger(year)) years.add(year as number);
  }
  return { ratings: [...ratings].sort(), years: [...years].sort((a, b) => a - b) };
}

export function yearItems(years: number[], serverId: string, sortOrder: unknown): any[] {
  const ascending = String(sortOrder ?? '').toLowerCase().startsWith('asc');
  return [...years]
    .sort((a, b) => (ascending ? a - b : b - a))
    .map((year) => namedItem('Year', String(year), yearItemId(year), serverId, { ProductionYear: year }));
}

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
