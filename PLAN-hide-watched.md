# Implementation Plan: Hide Watched Items from Catalogs

## Overview
Add a global toggle that filters out watched movies/shows from catalog results using Trakt watched history. When enabled, any catalog item the user has already watched (according to Trakt) will be removed from catalog results before being sent to Stremio.

## Architecture

### Flow
```
Catalog request → getCatalog() router → handler returns metas
    → applyWatchedFilter(metas, type, config) → filtered metas returned
```

The filter follows the same pattern as the existing `applyAgeRatingFilter()` — a post-processing step applied after each catalog handler returns its metas, inside `getCatalog()`.

### Watched data caching
- Trakt watched IDs are fetched once per user and cached in Redis for 1 hour
- Cache key: `watched:trakt:{userUUID}`
- Contains: `{ movieIds: string[], showIds: string[], fetchedAt: number }`
- Avoids hitting Trakt API on every catalog page request

### Catalog-level caching impact
- Add `hideWatched: true/false` to `extraArgs` in `index.js` so it becomes part of the catalog cache key
- This ensures filtered and unfiltered results are cached separately
- The watched filter runs INSIDE the `cacheWrapper` call, so cached catalog results already have watched items removed

### Excluded catalogs
These catalogs are NOT filtered (they're personal/progress lists where watched state is the point):
- `trakt.upnext`, `trakt.unwatched`, `trakt.watchlist`, `trakt.favorites`
- `trakt.calendar`
- `simkl.watchlist.*`, `simkl.calendar.*`
- `mdblist.upnext`
- `tmdb.watchlist`, `tmdb.favorites`

---

## Files to Modify

### 1. `addon/utils/traktUtils.ts` — Add `fetchTraktWatchedIds()`

**New function** ~40 lines:
```typescript
async function fetchTraktWatchedIds(accessToken: string): Promise<{ movieImdbIds: Set<string>, showImdbIds: Set<string> }> {
  // Fetch /sync/watched/movies and /sync/watched/shows in parallel
  // Extract IMDb IDs from each
  // Return as Sets for O(1) lookup
}
```

- Add `fetchTraktWatchedMovies()` (mirrors existing `fetchTraktWatchedShows()` but calls `/sync/watched/movies`)
- Add `fetchTraktWatchedIds()` that combines both into IMDb ID sets
- Export both new functions from the first `export {}` block

### 2. `addon/lib/getCatalog.ts` — Add watched filter + apply it

**New function** `applyWatchedFilter()` ~30 lines, following `applyAgeRatingFilter()` pattern:
```typescript
async function applyWatchedFilter(metas: any[], type: string, config: any, userUUID: string): Promise<any[]> {
  // Check if hideWatched is enabled and Trakt is connected
  // Get cached watched IDs (fetch from Trakt if not cached)
  // Filter metas: remove items whose id (tt*) is in the watched set
  // Log filtered count
}
```

**Apply in `getCatalog()` router** — after each handler returns metas, before `return { metas }`:
- Check if catalog ID is in the exclusion list
- If not excluded and `config.hideWatched` is enabled, apply filter

**New import**: `fetchTraktWatchedIds`, `getTraktAccessToken` from traktUtils

**Redis caching** for watched IDs:
- Use existing `cacheWrap()` or direct Redis calls
- Key: `watched:trakt:{userUUID}`, TTL: 3600s (1 hour)

### 3. `addon/index.js` — Pass hideWatched to cache key

In the catalog route handler (~line 3113), after existing `extraArgs` setup:
```javascript
if (config.hideWatched && config.apiKeys?.traktTokenId) {
  extraArgs.hideWatched = true;
}
```

This ensures the catalog cache key differs when hideWatched is enabled.

### 4. `configure/src/contexts/config.ts` — Add type definition

Add to `AppConfig` interface (~line 139, alongside watch tracking booleans):
```typescript
hideWatched: boolean;
```

### 5. `configure/src/contexts/ConfigContext.tsx` — Add default value

Add to default config (~line 140, alongside watch tracking defaults):
```typescript
hideWatched: false,
```

### 6. `configure/src/components/sections/GeneralSettings.tsx` — Add UI toggle

Add a new Switch toggle in the Watch Tracking section (~line 475, after the Simkl toggle):
- Label: "Hide Watched from Catalogs"
- Description: "Remove watched movies and shows from catalog results using your Trakt watch history. Requires Trakt connection."
- Handler: `setConfig(prev => ({ ...prev, hideWatched: checked }))`
- Disabled state when Trakt is not connected (no `traktTokenId`)

---

## Implementation Order

1. **Backend: traktUtils.ts** — Add `fetchTraktWatchedMovies()` + `fetchTraktWatchedIds()`
2. **Backend: getCatalog.ts** — Add `applyWatchedFilter()` function + apply in router
3. **Backend: index.js** — Add `hideWatched` to extraArgs/cache key
4. **Frontend: config.ts** — Add `hideWatched` to interface
5. **Frontend: ConfigContext.tsx** — Add default value
6. **Frontend: GeneralSettings.tsx** — Add toggle UI

## Notes

- Meta `id` fields starting with `tt` are IMDb IDs — direct match against Trakt watched data
- Non-IMDb IDs (`tmdb:`, `tvdb:`, `kitsu:`, `mal:`) won't be filtered (no efficient cross-lookup). This covers the vast majority of content since most movies/series resolve to IMDb IDs.
- Pagination: filtering may return fewer items per page than the page size. This is acceptable for Stremio's infinite scroll — consistent with how Filterist handles it.
