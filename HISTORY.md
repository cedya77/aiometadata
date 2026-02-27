# Development History

## feature/filter-watched — Hide Watched from Catalogs

**Date:** 2026-02-28
**Branch:** `feature/filter-watched`
**Based on:** `dev` @ `bd023d9`

### Overview

Added a global toggle that filters watched movies and shows out of catalog results using the user's Trakt watch history. When enabled, any catalog item the user has already watched (per Trakt) is removed before results are returned to Stremio.

### Files Changed

#### `addon/utils/traktUtils.ts`
- Added `fetchTraktWatchedMovies(accessToken)` — fetches `/sync/watched/movies` from Trakt using the same rate-limited request pattern as the existing `fetchTraktWatchedShows()`.
- Added `fetchTraktWatchedIds(accessToken, userUUID)` — calls both functions in parallel, extracts IMDb IDs into `Set<string>` objects, and caches the result in Redis for 1 hour (key: `watched:trakt:{userUUID}`). Returns `{ movieImdbIds, showImdbIds }`.
- Exported `fetchTraktWatchedIds` from the first export block.

#### `addon/lib/getCatalog.ts`
- Added import of `fetchTraktWatchedIds` from traktUtils.
- Added `WATCHED_FILTER_EXCLUDED_PREFIXES` — array of catalog ID prefixes that are never filtered (personal/progress lists where watched state is the point): `trakt.upnext`, `trakt.unwatched`, `trakt.watchlist`, `trakt.favorites`, `trakt.calendar`, `simkl.watchlist`, `simkl.calendar`, `mdblist.upnext`, `tmdb.watchlist`, `tmdb.favorites`.
- Added `applyWatchedFilter(metas, type, config, userUUID)` — async function that guards on `config.hideWatched` and `config.apiKeys.traktTokenId`, fetches watched IDs (Redis-cached), and filters out metas whose `id` starts with `tt` and is in the watched set. Logs the filtered count. Fails open (returns unfiltered metas) on error.
- Restructured `getCatalog()` router to collect results into a single `metas` variable across all branches, then apply the watched filter before returning. Previously each branch returned immediately; now there is a single `return { metas }` at the end (except the unknown-prefix branch which still returns early with `[]`).

#### `addon/index.js`
- Added `hideWatched: true` to `extraArgs` (just before `catalogKey` is built) when `config.hideWatched` is enabled and a Trakt token exists. This makes the cache key differ between filtered and unfiltered requests so the two states don't share a cache entry.

#### `configure/src/contexts/config.ts`
- Added `hideWatched: boolean` to the `AppConfig` interface, alongside the other watch-tracking booleans.

#### `configure/src/contexts/ConfigContext.tsx`
- Added `hideWatched: false` to the default config object.

#### `configure/src/components/sections/FiltersSettings.tsx`
- Added `handleHideWatchedChange` handler.
- Added a "Hide Watched" Card as the first filter on the Filters settings page (before Age Rating), consistent with the Card style used by other filters on that page.
- Card description lists the excluded personal lists and shows a yellow warning when Trakt is not connected.
- Switch is disabled when Trakt is not connected (`!config.apiKeys?.traktTokenId`).

### Bug Fix — Filter Placement

**Problem:** The watched filter was applied inside `getCatalog()`, but `index.js` contains a large `switch` statement that handles many catalog types directly (e.g. `tmdb.trending`, `tmdb.favorites`, `tmdb.watchlist`, all `mal.*` catalogs) without ever calling `getCatalog()`. These catalogs completely bypassed the filter.

**Fix:** Moved `applyWatchedFilter` to run in `index.js` **after the `cacheWrapper`**, alongside the other post-processing filters (`hideUnreleasedDigital`, `exclusionKeywords`, `regexExclusionFilter`). This is the correct pattern — it applies uniformly to every catalog type regardless of which handler produced the results.

- Exported `applyWatchedFilter` and `WATCHED_FILTER_EXCLUDED_PREFIXES` from `getCatalog.ts`
- Removed the filter call from inside `getCatalog()` router
- Removed `hideWatched: true` from `extraArgs`/cache key (not needed since filtering now runs outside the cache, matching the pattern of other post-processing filters)
- Added `applyWatchedFilter` call in `index.js` after the cacheWrapper, guarded by `!WATCHED_FILTER_EXCLUDED_PREFIXES` and excluding search catalog IDs

### Build Fix

During `docker build`, the TypeScript compiler caught that `getTraktAccessToken` takes a single `config` object (not a token ID string + UUID). Fixed `applyWatchedFilter` to pass `config` directly, which matches how all other callers use it.

### Design Decisions

- **Only IMDb IDs are filtered.** Metas with non-`tt` IDs (e.g. `tmdb:`, `kitsu:`, `mal:`) are left through — no efficient cross-lookup was implemented. This is acceptable since the vast majority of movie/series content resolves to IMDb IDs.
- **Filtering runs post-handler.** The filter is applied after each catalog handler returns, inside `getCatalog()`. This is the same pattern as `applyAgeRatingFilter()` inside the individual handlers.
- **Pagination may return fewer items than the page size.** This is consistent with how other post-processing filters (age rating, Filterist) behave with Stremio's infinite scroll.
- **Cache TTL for watched IDs: 1 hour.** Balances freshness against hitting the Trakt API on every catalog page request.
- **Excluded catalogs.** Personal/progress lists (up next, unwatched, watchlist, favorites, calendar) are excluded from filtering since their entire purpose is to surface watched/in-progress content.
- **UI placement.** The toggle lives on the Filters page (not General), because it is a content filter, not a watch-tracking/checkin feature.

### Ideas Backlog (not yet implemented)

1. **Hide watched in search results** — Currently only applies to catalogs. A second toggle `hideWatchedInSearch` would apply the same filter to search results (one extra call in the search route in `index.js`).
2. **Configurable cache TTL** — The 1-hour Redis TTL for watched IDs is hardcoded. A dropdown (15 min / 1 hr / 6 hrs / 24 hrs) would let users trade freshness for fewer Trakt API calls.
3. **"Fully watched" mode for TV shows** — Trakt's `/sync/watched/shows` marks a show as soon as *one* episode is watched. A strict mode could use Trakt's progress endpoint to only hide shows where all aired episodes are watched (i.e. truly completed series).
4. **Multi-source support** — Currently Trakt-only. Simkl also exposes a watch history endpoint (`/sync/all-items/watched`) and could be a natural extension given Simkl is already integrated.
