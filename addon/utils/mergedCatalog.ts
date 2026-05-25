import consola from 'consola';
const logger = consola.withTag('MergedCatalog');

/** Round-robin interleave: [[A1,A2,A3],[B1,B2]] -> [A1,B1,A2,B2,A3] */
export function roundRobinInterleave<T>(arrays: T[][]): T[] {
  const result: T[] = [];
  if (!arrays.length) return result;
  const maxLen = Math.max(...arrays.map(a => a.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const arr of arrays) {
      if (i < arr.length) result.push(arr[i]);
    }
  }
  return result;
}

/**
 * Multi-namespace dedup key. Mirrors extractIdsFromMeta logic in addon/index.js.
 * Returns the first available canonical id. Items lacking any usable id pass
 * through (treated as unique by passing null to the caller).
 */
export function mergedDedupKey(meta: any): string | null {
  if (!meta) return null;
  const id: string = meta.id || '';
  if (id.startsWith('tt')) return `imdb:${id}`;
  if (meta.imdb_id) return `imdb:${meta.imdb_id}`;
  if (id.startsWith('tmdb:')) return id;
  if (id.startsWith('tvdb:')) return id;
  if (id.startsWith('mal:')) return id;
  if (id.startsWith('anilist:')) return id;
  if (id.startsWith('kitsu:')) return id;
  if (id.startsWith('anidb:')) return id;
  if (id) return id;
  return null;
}

/** Dedup keeping first occurrence; items with no id pass through. */
export function dedupMetas(metas: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const meta of metas) {
    const key = mergedDedupKey(meta);
    if (!key) { out.push(meta); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(meta);
  }
  return out;
}

/**
 * Normalize a genre label to a canonical key for dedup grouping.
 * Strips combining diacritics, lowercases, and removes non-alphanumeric chars
 */
export function normalizeGenreKey(label: string): string {
  if (!label) return '';
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Union genre option lists from multiple source catalogs into a single
 * deduplicated, alphabetically-sorted list
 * Inputs of "None" and empty strings are filtered out
 */
export function mergeGenreOptions(perSourceOptions: string[][]): string[] {
  const firstSeen = new Map<string, string>();
  for (const opts of perSourceOptions) {
    if (!Array.isArray(opts)) continue;
    for (const raw of opts) {
      if (!raw || raw === 'None') continue;
      const key = normalizeGenreKey(raw);
      if (!key) continue;
      if (!firstSeen.has(key)) firstSeen.set(key, raw);
    }
  }
  return [...firstSeen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Filter merged-catalog metas to only those whose `genres` array contains a
 * label matching the requested genre under normalized comparison.
 *
 * Metas without a `genres` array are dropped: we can't verify their genre,
 * Empty or "None" requests bypass the filter (returns input unchanged).
 */
export function filterMetasByGenre(metas: any[], requestedGenre: string | undefined | null): any[] {
  if (!requestedGenre || requestedGenre === 'None') return metas;
  const wantKey = normalizeGenreKey(requestedGenre);
  if (!wantKey) return metas;
  return metas.filter((meta: any) => {
    const genres = meta?.genres;
    if (!Array.isArray(genres) || genres.length === 0) return false;
    for (const g of genres) {
      if (typeof g !== 'string') continue;
      if (normalizeGenreKey(g) === wantKey) return true;
    }
    return false;
  });
}

export { logger as mergedLogger };
