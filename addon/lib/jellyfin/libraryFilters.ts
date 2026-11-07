import { namedItem, yearItemId } from './dto';
import type { StudioFilter } from './items';

type Pick = (metas: any[]) => Promise<any[]>;
type StudioDescriptor = { k: 'studio'; n: string; s?: 'tmdb-company' | 'tmdb-network' | 'tvdb' | 'mal'; x?: number };

/** The ratings, years and studios a page holds, each once, as filter menus list them. */
export function facetsOf(entries: Array<{ rating: string | null; year: number | null; studios?: StudioDescriptor[] }>): { ratings: string[]; years: number[]; studios: StudioDescriptor[] } {
  const ratings = new Set<string>();
  const years = new Set<number>();
  const studios = new Map<string, StudioDescriptor>();
  for (const { rating, year, studios: named = [] } of entries) {
    if (rating) ratings.add(rating);
    if (Number.isInteger(year)) years.add(year as number);
    for (const studio of named) {
      const held = studios.get(studio.n);
      if (!held || (!held.x && studio.x)) studios.set(studio.n, studio);
    }
  }
  return {
    ratings: [...ratings].sort(),
    years: [...years].sort((a, b) => a - b),
    studios: [...studios.values()].sort((a, b) => a.n.localeCompare(b.n)),
  };
}

/** The studios a request names: StudioIds decoded to names, any other Id kept as the md5 Ids titles once carried, and Studios by name. */
export async function studioFilterOf(query: Record<string, unknown>, decode: (id: string) => Promise<any>): Promise<StudioFilter | null> {
  const filter: StudioFilter = { names: new Set(), legacy: new Set(), refs: [] };
  const ids = String(query.StudioIds ?? query.studioIds ?? '').split(/[|,]/).map((id) => id.trim()).filter(Boolean);
  for (const id of ids) {
    const descriptor = await decode(id).catch(() => null);
    if (descriptor?.k === 'studio') {
      filter.names.add(String(descriptor.n).toLowerCase());
      if (descriptor.s && descriptor.x) filter.refs.push({ name: descriptor.n, source: descriptor.s, id: descriptor.x });
    } else {
      // An md5 studio Id can start with a byte the codec reads as another kind; as a studio Id it matches only by hash.
      filter.legacy.add(id.replace(/-/g, '').toLowerCase());
    }
  }
  for (const name of String(query.Studios ?? query.studios ?? '').split('|').map((n) => n.trim()).filter(Boolean)) {
    filter.names.add(name.toLowerCase());
  }
  return filter.names.size || filter.legacy.size ? filter : null;
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
