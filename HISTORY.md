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

1. ~~**Hide watched in search results**~~ — **Implemented** (see Session 2 below).
2. **Configurable cache TTL** — The 1-hour Redis TTL for watched IDs is hardcoded. A dropdown (15 min / 1 hr / 6 hrs / 24 hrs) would let users trade freshness for fewer Trakt API calls.
3. ~~**"Fully watched" mode for TV shows**~~ — **Implemented** (see Session 2 below).
4. **Multi-source support** — Currently Trakt-only. Simkl also exposes a watch history endpoint (`/sync/all-items/watched`) and could be a natural extension given Simkl is already integrated.

---

## Session 2 — Fully Watched Logic, Search Filter, UI Polish & PR Submission

**Date:** 2026-02-28

### Changes

#### `addon/utils/traktUtils.ts`
- Added `fetchTraktWatchedShowsFull(accessToken)` — calls `/sync/watched/shows?extended=full` (no `noseasons`), returning full season/episode data and `show.aired_episodes`.
  - The existing `fetchTraktWatchedShows()` (which uses `?extended=noseasons`) was left untouched — it is still used by `fetchTraktUpNextEpisodes` and `fetchTraktUnwatchedEpisodes`, which only need show IDs and timestamps, not episode counts.
- Updated `fetchTraktWatchedIds()` to use `fetchTraktWatchedShowsFull` instead of `fetchTraktWatchedShows`, and to apply "fully watched" logic for shows:
  - Counts watched episodes by summing `seasons[].episodes.length` across all seasons in the response.
  - Compares against `show.aired_episodes` from the `extended=full` show object.
  - Only adds a show's IMDb ID to the filter set if `watchedEpisodes >= airedEpisodes`.
  - If `aired_episodes` is missing or 0 (edge case), falls back to the old "any watch" behaviour so the show is still filtered.
  - Movies are unchanged — filtered as soon as any watch is recorded.

#### `addon/lib/getCatalog.ts`
- Removed the `if (!config.hideWatched) return metas` guard from inside `applyWatchedFilter`. The caller in `index.js` now decides when to invoke the function, allowing it to be used for both catalog and search filtering with different config flags.
- Updated log message: `Filter watched: removed N watched type(s)`.

#### `addon/index.js`
- Replaced the old single-condition watched filter block with logic that handles catalogs and search independently:
  ```javascript
  const isSearchCatalog = ['search', 'people_search', 'gemini.search'].includes(cleanId);
  const isExcluded = WATCHED_FILTER_EXCLUDED_PREFIXES.some(prefix => cleanId.startsWith(prefix));
  if (!isExcluded) {
    const shouldFilter = isSearchCatalog ? !!config.hideWatchedInSearch : !!config.hideWatched;
    if (shouldFilter) {
      responseData.metas = await applyWatchedFilter(...);
    }
  }
  ```

#### `configure/src/contexts/config.ts`
- Added `hideWatchedInSearch: boolean` to the `AppConfig` interface.

#### `configure/src/contexts/ConfigContext.tsx`
- Added `hideWatchedInSearch: false` to the default config object.

#### `configure/src/components/sections/FiltersSettings.tsx`
- Renamed card title from "Hide Watched" → **"Watched Filter"** (consistent with naming on other filter cards).
- Updated card description to: *"Using your Trakt watch history, hide from all Catalogs or Search results all movies and shows you've already watched. Personal lists (Watchlist, Up Next, Unwatched, Calendar) are never filtered."*
- Replaced the single switch with two independent switches:
  - **"Hide Watched in Catalogs"** (`config.hideWatched`)
  - **"Hide Watched in Search"** (`config.hideWatchedInSearch`)
- Both switches are disabled when Trakt is not connected.
- Added `handleHideWatchedInSearchChange` handler.

### Design Decisions

- **`fetchTraktWatchedShowsFull` is a separate function** rather than modifying `fetchTraktWatchedShows`, because the noseasons version is still used by two other internal functions that don't need episode counts. Modifying it would have caused unnecessary response bloat for those callers.
- **Fully watched = `watchedEpisodes >= airedEpisodes`**. This correctly handles ongoing shows (new episodes push `aired_episodes` up, causing the show to reappear) and completed shows (once all aired episodes are watched, the show stays filtered).
- **Guard moved to call site.** `applyWatchedFilter` no longer checks `config.hideWatched` internally — the caller in `index.js` decides when to call it, enabling the same function to serve both catalog and search contexts with different config flags.

### GitHub

- Commit: `e4bb5e9` (amended from `db7ace0`)
- Fork: `github.com/pedantique/aiometadata` branch `feature/filter-watched`
- PR submitted to `cedya77/aiometadata` targeting `dev` branch

### Maintaining Your Fork

If a new upstream `dev` release comes out while your PR is open, you will need to rebase your branch onto the new `dev`:

```bash
cd /Users/darren/aiometadata
git fetch origin
git rebase origin/dev
git push fork feature/filter-watched --force
```

This replays your single commit on top of the latest upstream code and force-pushes to update the PR automatically. If there are conflicts, Git will pause and show you what to resolve before continuing with `git rebase --continue`.
