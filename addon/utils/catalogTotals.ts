/**
 * How many titles a catalog holds, when its source says so in the same reply
 * (PublicMetaDB `total`, TMDB `total_results`). A Stremio catalog page carries
 * no total, so the count rides beside the metas array it describes and the
 * catalog route turns it into a `total` field the Jellyfin layer can report.
 */
const totals = new WeakMap<object, number>();

/** Remember the catalog's size for this page of metas, and hand the page back. */
export function withCatalogTotal<T>(metas: T, total: unknown): T {
  const n = Number(total);
  if (Array.isArray(metas) && total !== null && total !== undefined && Number.isFinite(n) && n >= 0) {
    totals.set(metas, Math.floor(n));
  }
  return metas;
}

export function catalogTotalOf(metas: unknown): number | undefined {
  return Array.isArray(metas) ? totals.get(metas) : undefined;
}

/** A merged catalog's size: the sum of its parts, known only when every part is. */
export function sumCatalogTotals(parts: Array<number | undefined>): number | undefined {
  if (!parts.length || parts.some((n) => typeof n !== 'number')) return undefined;
  return parts.reduce<number>((sum, n) => sum + (n as number), 0);
}

/**
 * Whether a source's own count describes the list a client asked for: true
 * unless the list keeps only some of the types the catalog holds, or filters by
 * rating or by what was played (the caller passes that as `narrowed`). A movie
 * catalog holds films, a series catalog shows, anything else (merged, external)
 * either.
 */
export function sourceCountApplies(catalogType: string, includeItemTypes?: string, narrowed = false): boolean {
  if (narrowed) return false;
  const wanted = new Set(String(includeItemTypes ?? '').split(',').map((t) => t.trim()).filter(Boolean));
  if (!wanted.size) return true;
  if (catalogType === 'movie') return wanted.has('Movie');
  if (catalogType === 'series') return wanted.has('Series');
  return wanted.has('Movie') && wanted.has('Series');
}

/**
 * TotalRecordCount for one Jellyfin list window.
 *
 * Without a known size, one page of lookahead keeps a client asking and settles
 * on the truth once the catalog runs out. A known size is an upper bound once
 * filters drop titles, so it is reported only while it is still ahead of what
 * was served; past the end, the known size wins over the index asked for.
 */
export function listTotal(opts: {
  startIndex: number;
  served: number;
  pageLimit: number;
  hasMore: boolean;
  known?: number;
}): number {
  const reached = opts.startIndex + opts.served;
  const known = typeof opts.known === 'number' && Number.isFinite(opts.known) ? opts.known : undefined;
  if (!opts.hasMore || opts.served === 0) {
    if (opts.served === 0 && known !== undefined && known < reached) return known;
    return reached;
  }
  if (known !== undefined && known > reached) return known;
  return reached + opts.pageLimit;
}
