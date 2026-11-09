import { namedItem, yearItemId } from './dto';
import type { StudioFilter } from './items';

type Pick = (metas: any[]) => Promise<any[]>;
type StudioDescriptor = { k: 'studio'; n: string; s?: 'tmdb-company' | 'tmdb-network' | 'tvdb' | 'mal'; x?: number };

const MENU_TAGS = 30;

/** The ratings, years, studios and most frequent tags a page holds, each once, as filter menus list them. */
export function facetsOf(entries: Array<{ rating: string | null; year: number | null; studios?: StudioDescriptor[]; tags?: string[] }>): { ratings: string[]; years: number[]; studios: StudioDescriptor[]; tags: string[] } {
  const ratings = new Set<string>();
  const years = new Set<number>();
  const studios = new Map<string, StudioDescriptor>();
  const tags = new Map<string, { name: string; count: number }>();
  for (const { rating, year, studios: named = [], tags: tagged = [] } of entries) {
    if (rating) ratings.add(rating);
    if (Number.isInteger(year)) years.add(year as number);
    for (const studio of named) {
      const held = studios.get(studio.n);
      if (!held || (!held.x && studio.x)) studios.set(studio.n, studio);
    }
    for (const tag of new Set(tagged.map((t) => String(t).trim()).filter(Boolean))) {
      const key = tag.toLowerCase();
      const held = tags.get(key);
      tags.set(key, { name: held?.name ?? tag, count: (held?.count ?? 0) + 1 });
    }
  }
  return {
    ratings: [...ratings].sort(),
    years: [...years].sort((a, b) => a - b),
    studios: [...studios.values()].sort((a, b) => a.n.localeCompare(b.n)),
    tags: [...tags.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, MENU_TAGS).map((t) => t.name),
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

export function asksForResumable(query: Record<string, unknown>): boolean {
  return String(query.Filters ?? query.filters ?? '').split(',').map((f) => f.trim()).includes('IsResumable');
}

const EXCLUDED_MAX = 100;

/** The item Ids a request leaves out, normalised as item Ids are compared; null when it names none. */
export function excludedIds(query: Record<string, unknown>): Set<string> | null {
  const ids = String(query.ExcludeItemIds ?? query.excludeItemIds ?? '').split(',').map((id) => id.trim().replace(/-/g, '').toLowerCase()).filter((id) => /^[0-9a-f]{32}$/.test(id));
  return ids.length ? new Set(ids.slice(0, EXCLUDED_MAX)) : null;
}

/** The catalog ids of the titles a request leaves out; null when it names none. */
export async function excludedTitles(query: Record<string, unknown>, decode: (id: string) => Promise<any>): Promise<Set<string> | null> {
  const ids = excludedIds(query);
  if (!ids) return null;
  const descriptors = await Promise.all([...ids].map((id) => decode(id).catch(() => null)));
  const titles = new Set(descriptors.filter((d) => (d?.k === 'movie' || d?.k === 'series') && d.i).map((d) => String(d.i)));
  return titles.size ? titles : null;
}

/** A walk's filter that also leaves out the excluded titles, so a page and the next count the same list. */
export function withoutTitles(keep: ((meta: any) => boolean) | undefined, excluded: Set<string> | null): ((meta: any) => boolean) | undefined {
  if (!excluded) return keep;
  return (meta: any) => !excluded.has(String(meta?.id)) && (!keep || keep(meta));
}

export function excludedKey(excluded: Set<string> | null): string {
  return excluded ? `#not:${[...excluded].sort().join(',')}` : '';
}

/**
 * Catalogs report no total, so one page of lookahead keeps the client asking and collapses to the truth once the
 * catalog runs out. A filtered page the budget cut short stays open even when empty, since the next ask reads on.
 */
export function listTotal(startIndex: number, shown: number, pageLimit: number, window: { hasMore: boolean; truncated?: boolean; length?: number }): number {
  if (window.hasMore && (shown > 0 || window.truncated)) return startIndex + shown + pageLimit;
  // Asked past the end of a list that has run out, the total is the list's own length.
  return window.length !== undefined ? Math.min(window.length, startIndex + shown) : startIndex + shown;
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

export type ProviderId = { provider: 'imdb' | 'tmdb' | 'tvdb'; id: string };

/** The `provider.id` pairs of AnyProviderIdEquals that name a title this server can build, or null when none was asked. */
export function providerIdsAsked(query: Record<string, unknown>): ProviderId[] | null {
  const raw = query.AnyProviderIdEquals ?? query.anyProviderIdEquals;
  if (raw === undefined || raw === null || raw === '') return null;
  const asked: ProviderId[] = [];
  for (const entry of String(raw).split(',')) {
    const dot = entry.indexOf('.');
    if (dot < 0) continue;
    const provider = entry.slice(0, dot).trim().toLowerCase();
    const id = entry.slice(dot + 1).trim().toLowerCase();
    if (provider === 'imdb' && /^tt\d+$/.test(id)) asked.push({ provider, id });
    else if ((provider === 'tmdb' || provider === 'tvdb') && /^\d+$/.test(id)) asked.push({ provider, id });
  }
  return asked;
}

/** The title ids to build for the pairs asked: a TMDB or TVDB number names a film and a show apart, so both kinds are tried unless one was asked. */
export function titleIdsFor(asked: ProviderId[], includeItemTypes: unknown): Array<{ kind: 'movie' | 'series'; id: string }> {
  const wanted = new Set(String(includeItemTypes ?? '').split(',').map((t) => t.trim()).filter(Boolean));
  const kinds = (['movie', 'series'] as const).filter((kind) => !wanted.size || wanted.has(kind === 'movie' ? 'Movie' : 'Series'));
  const out: Array<{ kind: 'movie' | 'series'; id: string }> = [];
  for (const { provider, id } of asked) {
    const titleId = provider === 'imdb' ? id : `${provider}:${id}`;
    for (const kind of kinds) out.push({ kind, id: titleId });
  }
  return out;
}

const heldIds = (item: any): Map<string, string> =>
  new Map(Object.entries(item?.ProviderIds ?? {}).map(([provider, id]) => [provider.toLowerCase(), String(id).toLowerCase()]));

/** Whether a built item carries one of the asked ids, so a title of the other kind under the same number is left out. */
export function carriesProviderId(item: any, asked: ProviderId[]): boolean {
  const held = heldIds(item);
  return asked.some(({ provider, id }) => held.get(provider) === id);
}

/**
 * A TMDB or TVDB number asked with no type names a film and an unrelated show alike, so one title is kept for it:
 * the film for TMDB and the show for TVDB, or the other kind where that one is missing.
 */
export function oneTitlePerNumber(items: any[], asked: ProviderId[]): any[] {
  const dropped = new Set<any>();
  for (const { provider, id } of asked) {
    if (provider === 'imdb') continue;
    const named = items.filter((item) => heldIds(item).get(provider) === id);
    const preferred = provider === 'tmdb' ? 'Movie' : 'Series';
    const kept = named.find((item) => item.Type === preferred) ?? named[0];
    for (const item of named) if (item !== kept) dropped.add(item);
  }
  return dropped.size ? items.filter((item) => !dropped.has(item)) : items;
}
