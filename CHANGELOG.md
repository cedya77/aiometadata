# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [1.19.1](https://github.com/cedya77/aiometadata/compare/v1.19.0...v1.19.1) (2025-12-31)


### Bug Fixes

* **user management:** resolve issue with password reset ([4be921a](https://github.com/cedya77/aiometadata/commit/4be921abc54654e83766a90f10ad7d68e8cb3bec))


### Reverts

* temporarily revert to fribbs previous list update containing imdb ids ([a980fe1](https://github.com/cedya77/aiometadata/commit/a980fe16d770286b0a25af1d58bb73050ce7c2e8))

## [1.19.0](https://github.com/cedya77/aiometadata/compare/v1.18.2...v1.19.0) (2025-12-31)


### Features

* add HIDIVE as streaming provider ([8e17731](https://github.com/cedya77/aiometadata/commit/8e17731bebeaeb42b47e9c359fc577dbc8dff905))
* add sort options to streaming catalogs ([ed4cdb3](https://github.com/cedya77/aiometadata/commit/ed4cdb39b6574f6e5d4a074138d4b9faa86d7350))


### Bug Fixes

* **manifest:** make id generation more unique to fix edge cases with display types ([aee5a5b](https://github.com/cedya77/aiometadata/commit/aee5a5b5537d81f2f13a8ba53454f41c57a9ce8d))
* **mdblist:** fix list type assignement when adding lists via username ([136a477](https://github.com/cedya77/aiometadata/commit/136a4779bb86326d8339294fb2b0bc1131d4ecb1))

## [1.18.2](https://github.com/cedya77/aiometadata/compare/v1.18.1...v1.18.2) (2025-12-29)


### Bug Fixes

* **letterboxd:** fix error when letterboxd would return type show for series ([f1ce58c](https://github.com/cedya77/aiometadata/commit/f1ce58c726376d1358410c7e869b97d250f6faab))
* **mdblist:** implement a per key rate limiter to avoid global cooldown ([f1ce58c](https://github.com/cedya77/aiometadata/commit/f1ce58c726376d1358410c7e869b97d250f6faab))

## [1.18.1](https://github.com/cedya77/aiometadata/compare/v1.18.0...v1.18.1) (2025-12-29)


### Bug Fixes

* trakt refresh token logic ([0f37952](https://github.com/cedya77/aiometadata/commit/0f379521397570c9b7b195945f4dfce97008e5a9))
* trakt refresh token logic ([e79b3a6](https://github.com/cedya77/aiometadata/commit/e79b3a62e02cf38106f98ce637feaf3d49f4b22e))

## [1.18.0](https://github.com/cedya77/aiometadata/compare/v1.17.0...v1.18.0) (2025-12-28)


### Features

* **letterboxd:** Add letterboxd integration with list/watchlist url import support ([47d0464](https://github.com/cedya77/aiometadata/commit/47d0464d55dd58a8dd7a7b0be4ded5bba269e43a))
* **rate me:** only add stream resource when rate me is activated ([38a2824](https://github.com/cedya77/aiometadata/commit/38a282444e205fd3ad1d098018ee193d547e6cf8))


### Bug Fixes

* **imdb meta:** show age rating for imdb meta ([3ce2ba7](https://github.com/cedya77/aiometadata/commit/3ce2ba77c44e1f7d44a0c4c64a173692f13fae5e))
* **search:** fix digital release filter not being correctly disabled for search only ([fa17c2f](https://github.com/cedya77/aiometadata/commit/fa17c2fee361021d00e4e102c53819dde7006a88))
* **trakt genres:** show name instead of slug in stremio ([1f0cf69](https://github.com/cedya77/aiometadata/commit/1f0cf697b632e87135f736525793c10113028994))
* **up next:** prevent rpdb from applying to thumbnails ([fa17c2f](https://github.com/cedya77/aiometadata/commit/fa17c2fee361021d00e4e102c53819dde7006a88))

## [1.17.0](https://github.com/cedya77/aiometadata/compare/v1.16.0...v1.17.0) (2025-12-26)


### Features

* add DISABLE_METRICS env var to disable metrics collection ([71c044f](https://github.com/cedya77/aiometadata/commit/71c044ff73d72835418c187213350a9f4e951f21))
* Add Rate Me button as genre in meta pages ([fa2c218](https://github.com/cedya77/aiometadata/commit/fa2c218451297c6c5ebe18cdbcca1a6c99bfee43))
* Add rating page with multi-service support (Trakt, AniList, MDBList) ([228ada5](https://github.com/cedya77/aiometadata/commit/228ada57585b006e362b3b4873f98c07aec6bc97))
* **search:** add option to filter digital releases for searches only ([67f2ada](https://github.com/cedya77/aiometadata/commit/67f2adaa7f293fea85b5e55d4d74f9cf91a9d7af))
* support blur endpoint for TOP Poster API ([fc6143a](https://github.com/cedya77/aiometadata/commit/fc6143a556dd983672c87e798a5f8721d88a9c6c))
* support blur endpoint for TOP Poster API ([424c127](https://github.com/cedya77/aiometadata/commit/424c1271eef3a13e057337035c77f8778b935100))
* **trakt:** Add trakt trending/popular movies/shows catalogs ([911f4a1](https://github.com/cedya77/aiometadata/commit/911f4a1d679f6528a93f9b70a9086d5561e0b22f))


### Bug Fixes

* address TUN bug, enhance cache efficiency ([5fe3880](https://github.com/cedya77/aiometadata/commit/5fe3880d0660d5edfe5067c2c0418cf66f7be295))
* enable necessary metrics for Ratings page functionality ([95e63bd](https://github.com/cedya77/aiometadata/commit/95e63bd5cb7f2b8cf60baf38481777098641717e))
* enable necessary metrics for Ratings page functionality ([7a6a419](https://github.com/cedya77/aiometadata/commit/7a6a419762a6b50ba5dee4ed7862f86d16d15926))
* ensure MDBList API key test uses rate limiter ([0e40ba4](https://github.com/cedya77/aiometadata/commit/0e40ba4e73368ba23edef9a747a52e20b7494f27))
* **mdblist:** fix import by list url ([2778c7a](https://github.com/cedya77/aiometadata/commit/2778c7ad9043e6b773f6a9c484755b6edf816fae))
* **mdblist:** pass unified paramater to query for mixed lists so that order is kept ([2778c7a](https://github.com/cedya77/aiometadata/commit/2778c7ad9043e6b773f6a9c484755b6edf816fae))
* proxy frontend Trakt calls through backend rate limiter ([17d80b7](https://github.com/cedya77/aiometadata/commit/17d80b7e71ef75a44cc52809cb8b7bd29aaa77fd))
* **trakt:** Filter dropped shows from Trakt Up Next and Recently Aired catalogs ([9cea060](https://github.com/cedya77/aiometadata/commit/9cea060b61b62a0129baa723917ecba819d38fe3))


### Reverts

* discard getMeta.js changes from PR 181 ([3dd7ddf](https://github.com/cedya77/aiometadata/commit/3dd7ddfef51cdd54f15f7538f22001b85fa56cee))

## [1.16.0](https://github.com/cedya77/aiometadata/compare/v1.15.0...v1.16.0) (2025-12-22)


### Features

* proxy frontend MDBList calls through backend rate limiter ([bfd1278](https://github.com/cedya77/aiometadata/commit/bfd1278659202bfdeac2ac2b9f4d1e84e43fce97))
* proxy frontend MDBList calls through backend rate limiter ([553cea2](https://github.com/cedya77/aiometadata/commit/553cea200995943ff2ed6c537bbb816f2193aecb))

## [1.15.0](https://github.com/cedya77/aiometadata/compare/v1.14.2...v1.15.0) (2025-12-21)


### Features

* **manifest:** allow logo override via ADDON_LOGO_URL env var ([790bf62](https://github.com/cedya77/aiometadata/commit/790bf62d38ff455377cd512de502f0cbf9bd7297))


### Bug Fixes

* **cors:** add global CORS middleware to ensure all responses include CORS headers ([f7e6880](https://github.com/cedya77/aiometadata/commit/f7e68807e14fdaa568c227366e5f3f1484929d45))
* Hide Episode Spoilers now works with TOP API ([88dea98](https://github.com/cedya77/aiometadata/commit/88dea98abe4d2bbae878fb526b693c1491a27338))
* prevent unbounded growth on cacheHealth metrics ([a914290](https://github.com/cedya77/aiometadata/commit/a91429064cff243817b3d61001eb7f65bee681ca))
* treat 500 as retryable ([dcb1376](https://github.com/cedya77/aiometadata/commit/dcb13760dccb0573b6e92e78d8a0049ca18ef2b9))
* treat 500 as retryable ([7a5fbb6](https://github.com/cedya77/aiometadata/commit/7a5fbb69b1c68773f353d2cac71997f91e74618a))
* **up next:** invalidate meta cache via ep number ([5765133](https://github.com/cedya77/aiometadata/commit/57651331dec2f8843680719ad5bdd0634b45c4f0))
* use retry-after header for trakt ([9908807](https://github.com/cedya77/aiometadata/commit/9908807aaee8b47506866877165ed719c9f4f596))
* use retry-after header for trakt ([0065151](https://github.com/cedya77/aiometadata/commit/006515173a1fda4598019f16c957d651b41a9d77))


### Performance Improvements

* Optimize anime ID lookups from O(N) to O(1) ([c306a86](https://github.com/cedya77/aiometadata/commit/c306a86d7da47d2d75330c0e1a7807d53c81cd20))
* use redis pipeline for requestTracker.js ([3dd4e8f](https://github.com/cedya77/aiometadata/commit/3dd4e8fe60729dbc4a7cbb28365d85971eea5e5e))

## [1.14.2](https://github.com/cedya77/aiometadata/compare/v1.14.1...v1.14.2) (2025-12-18)


### Bug Fixes

* add missing func for oAuth token updates ([e4dc777](https://github.com/cedya77/aiometadata/commit/e4dc777034e2f22e42e5f99b506c1065a682102f))
* address load trending lists error ([1963bae](https://github.com/cedya77/aiometadata/commit/1963bae6bb35aed1af186f0b199ad26f272c28ef))
* **meta:** strip upnext/unwatched/tun prefixes before rebuilding RPDB proxy URL ([7dd2692](https://github.com/cedya77/aiometadata/commit/7dd26927a571b3a8c13edc019d7c015d42ead54c))
* **streaming catalogs - paramount:** update provider id ([f11467f](https://github.com/cedya77/aiometadata/commit/f11467fb710653d7e379d23cd686e6b13054aa76))
* update anilist label ([83e94e5](https://github.com/cedya77/aiometadata/commit/83e94e51f300d4861f7bd13c9d5dbffefc504d02))
* update anilist label ([f6342c2](https://github.com/cedya77/aiometadata/commit/f6342c2bed6d471cc42bc6657ee291beab03a422))

## [1.14.1](https://github.com/cedya77/aiometadata/compare/v1.14.0...v1.14.1) (2025-12-16)


### Bug Fixes

* **mdblist:** missing validation condition ([812d6be](https://github.com/cedya77/aiometadata/commit/812d6be080746e3dd5358edf67b8d530aa2f8cc9))
* **trakt:** convert token expiry to string for postgres users ([812d6be](https://github.com/cedya77/aiometadata/commit/812d6be080746e3dd5358edf67b8d530aa2f8cc9))

## [1.14.0](https://github.com/cedya77/aiometadata/compare/v1.13.2...v1.14.0) (2025-12-16)


### Features

* add Criterion Channel streaming provider ([0cd3794](https://github.com/cedya77/aiometadata/commit/0cd3794bb5a940cd7a2f6ee51d0bf815e5b658ea))
* add Criterion Channel streaming provider ([7f16c68](https://github.com/cedya77/aiometadata/commit/7f16c6801530665a1e844865fae8b3a2913f23ab))
* **manifest:** add unwatched_ ID prefix ([a14d8e3](https://github.com/cedya77/aiometadata/commit/a14d8e3fbabcde7cd1426465355da805d8e8d206))
* **mdblist:** add support for external lists ([cca3bd2](https://github.com/cedya77/aiometadata/commit/cca3bd2b4b50fcafc7089ec2c20a2ad94d4cc08a))
* prevent marking watch status repeatedly ([0888bdb](https://github.com/cedya77/aiometadata/commit/0888bdb163221693f828c440ecda2ee22301d0ee))
* prevent marking watch status repeatedly ([56755fe](https://github.com/cedya77/aiometadata/commit/56755fe9f1aa1639a69bcf6453d2031bcc08dd5f))
* **settings:** add timezone configuration ([a14d8e3](https://github.com/cedya77/aiometadata/commit/a14d8e3fbabcde7cd1426465355da805d8e8d206))
* start implementing AL tracking and catalogs ([14f0b4c](https://github.com/cedya77/aiometadata/commit/14f0b4cd6d9a1651bb854aac976c8dc4d882fbb1))
* **trakt up next:** add show poster toggle, cache key support, and Kitsu pagination fix ([a66ce63](https://github.com/cedya77/aiometadata/commit/a66ce63bc847f8fdcb1a4b93e366fd3a0bfdbbdc))
* **trakt:** add Airing Soon calendar catalog ([a14d8e3](https://github.com/cedya77/aiometadata/commit/a14d8e3fbabcde7cd1426465355da805d8e8d206))
* **trakt:** add My Recently Aired and Airing Soon catalogs with timezone support ([a14d8e3](https://github.com/cedya77/aiometadata/commit/a14d8e3fbabcde7cd1426465355da805d8e8d206))
* **trakt:** add My Recently Aired catalog ([a14d8e3](https://github.com/cedya77/aiometadata/commit/a14d8e3fbabcde7cd1426465355da805d8e8d206))
* **trakt:** enhance custom lists with split option ([a14d8e3](https://github.com/cedya77/aiometadata/commit/a14d8e3fbabcde7cd1426465355da805d8e8d206))


### Bug Fixes

* finish implementing automatic Trakt token refresh ([3e7c3e9](https://github.com/cedya77/aiometadata/commit/3e7c3e9b25ef1bc423eee234f9fa80c802fb8a66))
* **mdblist:** type guard response.headers and extend rateLimitState for new rate limit headers ([19ba774](https://github.com/cedya77/aiometadata/commit/19ba774754bcf5ec4550e8a181568b677a014d1e))
* **streaming catalogs:** resolve issue with some providers showing few items ([47bc793](https://github.com/cedya77/aiometadata/commit/47bc793f9f0924a784409332a3b8c460866f55f8))
* **trakt:** reduce retries for individual show fetches in Up Next ([d1037bd](https://github.com/cedya77/aiometadata/commit/d1037bd62d8a39e9f9d62742a2817d393b8fd764))

## [1.13.2](https://github.com/cedya77/aiometadata/compare/v1.13.1...v1.13.2) (2025-12-10)


### Bug Fixes

* **trakt:** add deselect all buttons for multi-select lists ([02c250d](https://github.com/cedya77/aiometadata/commit/02c250d6a530ae5370315d28eb10524aa7529156))
* **trakt:** fix sort direction parameter not being sent to API requests ([02c250d](https://github.com/cedya77/aiometadata/commit/02c250d6a530ae5370315d28eb10524aa7529156))
* **trakt:** prevent trending/popular list stacking in UI ([02c250d](https://github.com/cedya77/aiometadata/commit/02c250d6a530ae5370315d28eb10524aa7529156))
* **trakt:** support official lists with null user slug ([f681857](https://github.com/cedya77/aiometadata/commit/f681857b6d4ca242b221eff90b4b5d536d1369be))

## [1.13.1](https://github.com/cedya77/aiometadata/compare/v1.13.0...v1.13.1) (2025-12-10)


### Bug Fixes

* **trakt ui:** remove trakt secret for integration disabling condition ([b7a7b5d](https://github.com/cedya77/aiometadata/commit/b7a7b5d7f6cfe4fa64af1d42d804637b057ad2b1))

## [1.13.0](https://github.com/cedya77/aiometadata/compare/v1.12.0...v1.13.0) (2025-12-10)


### Features

* add  metadata (itemCount, author) for all MDBList catalog imports and display ([9634c4e](https://github.com/cedya77/aiometadata/commit/9634c4e7dbee2c200fd6995b2369092df5da1aef))
* add MDBList top list import ([50abe0e](https://github.com/cedya77/aiometadata/commit/50abe0e921fa794ea24265464c168e87a4bb75da))
* Complete Trakt integration with all catalog types and optimizations ([e9eca39](https://github.com/cedya77/aiometadata/commit/e9eca39c7cdcb963f2374454fb9b7c32504dbab3))
* **ui:** enable Enter key submission in Header login form ([887f727](https://github.com/cedya77/aiometadata/commit/887f7273328eddfc44202f36a31b627ffa8a450c))
* **ui:** enable Enter key submission in Header login form ([8b03b0b](https://github.com/cedya77/aiometadata/commit/8b03b0bbf35fabe963dee992e40af0a4eea77538))


### Bug Fixes

* **anime art:** use the same art for catalog and meta even when use imdb id for MAL catalogs/search ([0375ccf](https://github.com/cedya77/aiometadata/commit/0375ccfb1a795167936574c74c749a1dbde9c809))
* **config:** safe SCAN-based deletion for meta cache clearing to avoid callstack/KEYS issues ([86efcce](https://github.com/cedya77/aiometadata/commit/86efcce6fd39070ddbc5ac2cad1b5ae928d99d28))
* gemini validation ([fd7a09f](https://github.com/cedya77/aiometadata/commit/fd7a09f83695d6fa652ac574f1b482665e5fbf16))
* gemini validation ([9c28306](https://github.com/cedya77/aiometadata/commit/9c2830662ea3f5ffc6a83d7624c72d0ad14f1b32))
* **top rating:** use the correct endpoint for api key testing ([6ef0c70](https://github.com/cedya77/aiometadata/commit/6ef0c7099a226b30de0369b6e29844297f3b07bf))

## [1.12.0](https://github.com/cedya77/aiometadata/compare/v1.11.0...v1.12.0) (2025-11-29)


### Features

* add IMDb ID search support to TMDB, TVDB, and TVMaze ([753bd84](https://github.com/cedya77/aiometadata/commit/753bd847a08366cef1393b9f23f4ac411abb6fa0))
* add Top Poster API integration for rating posters ([4cf583a](https://github.com/cedya77/aiometadata/commit/4cf583ab1a1273529b10c8c780dcaba506a27adc))
* **episodes:** add Top Poster API support for episode thumbnails ([4cf583a](https://github.com/cedya77/aiometadata/commit/4cf583ab1a1273529b10c8c780dcaba506a27adc))
* implement gemini client, tweak prompt, improve perf ([e0074ad](https://github.com/cedya77/aiometadata/commit/e0074ad438588bb107ec46cd0be5aa07fd795a36))
* implement gemini search ([d15e10d](https://github.com/cedya77/aiometadata/commit/d15e10d78ed1bf010b1539f7de20be9883ee62d8))
* **kitsu:** enrich meta with tmdb info for consistent thumbnails and ep title/overview ([6170037](https://github.com/cedya77/aiometadata/commit/617003700cbcbb05affdb8fd692a04c4159cf8a4))
* **search:** Make AI search sortable and bump number of results to 20. ([f604a7e](https://github.com/cedya77/aiometadata/commit/f604a7e8c72be2da5162e42ac8dbcc894de2ded8))


### Bug Fixes

* correct manifest.json fields to match spec ([03bc6ba](https://github.com/cedya77/aiometadata/commit/03bc6ba8a518e91948ef4374702d7736fba0fa88)), closes [#132](https://github.com/cedya77/aiometadata/issues/132)
* ensure logo fallback works in catalog endpoint and fix MDBList unified watchlist parsing ([eb277b0](https://github.com/cedya77/aiometadata/commit/eb277b04a1348ac4c25bd9232b60c0242bdbd988))
* **frontend:** Conditionally display addon password for user deletion ([fc87102](https://github.com/cedya77/aiometadata/commit/fc87102aad83c53d5517929a8782d27d02292ab8))
* **kitsu:** avoid using unreliable TMDB fallbacks for franchise fallback mappings; use background for upcoming episode thumbnails; ([ad91a43](https://github.com/cedya77/aiometadata/commit/ad91a43cf5d4f0033b5cb1c6d1b52d3825bd7c6c))
* **mal cache warming:** resolve issue with genre value not matching index call when show in home is false for MAL, TVDB & TVMaze catalogs ([debbefd](https://github.com/cedya77/aiometadata/commit/debbefd89ae5ca8638af52a3228c684092cd3400))
* **mdblist:** correct unified watchlist response parsing ([eb277b0](https://github.com/cedya77/aiometadata/commit/eb277b04a1348ac4c25bd9232b60c0242bdbd988))
* **meta:** move IMDB logo fallback outside includeVideos block in buildTvdbSeriesResponse ([eb277b0](https://github.com/cedya77/aiometadata/commit/eb277b04a1348ac4c25bd9232b60c0242bdbd988))
* **search:** show TVDB search in dropdown with API key required indicator ([2a0eaa5](https://github.com/cedya77/aiometadata/commit/2a0eaa5ab03723294aea797e14500b141e909fd5))
* **wiki:** HTTP 429 error handling in wiki-mapper with retry logic and cache fallback ([62c010a](https://github.com/cedya77/aiometadata/commit/62c010a855664bd70b51a0847ff0a678889267e6))

## [1.11.0](https://github.com/cedya77/aiometadata/compare/v1.10.0...v1.11.0) (2025-11-21)


### Features

* add TMDB top rated and airing today catalogs ([2fc0ffb](https://github.com/cedya77/aiometadata/commit/2fc0ffba83ae307d0473cf44c2b9d525dad2d983))
* **catalogs:** add airing today catalog with origin country filter ([2fc0ffb](https://github.com/cedya77/aiometadata/commit/2fc0ffba83ae307d0473cf44c2b9d525dad2d983))
* **catalogs:** add top rated movies and TV catalogs ([2fc0ffb](https://github.com/cedya77/aiometadata/commit/2fc0ffba83ae307d0473cf44c2b9d525dad2d983))


### Bug Fixes

* **auth:** move TMDB authentication flow to frontend ([2fc0ffb](https://github.com/cedya77/aiometadata/commit/2fc0ffba83ae307d0473cf44c2b9d525dad2d983))
* **cache:** ensure rpdbEnabled is always boolean in catalog cache keys ([9cd0601](https://github.com/cedya77/aiometadata/commit/9cd06011b5798f217857f6f306d2ac02c86a82d6))
* **import:** use full replacement for config import ([6031911](https://github.com/cedya77/aiometadata/commit/6031911793e8abcccbafcc1190c673793985ee4d))
* tmdb auth flow ([ff7aba4](https://github.com/cedya77/aiometadata/commit/ff7aba41bb3ffbbfbcd92729861ca1bdc29011fe))


### Performance Improvements

* compile regex pattern once ([19272a7](https://github.com/cedya77/aiometadata/commit/19272a75a69f2c6d9d2d11d7dcb10cd169f6063e))
* parallelize tracking operations ([829d896](https://github.com/cedya77/aiometadata/commit/829d896ee59315cb3aa8d1c908e1f574c7e3f5cb))
* simplify and parallelize requestTracker further ([0839d65](https://github.com/cedya77/aiometadata/commit/0839d65bf1e3f8bd04f2ac2cf594a97aae772239))

## [1.10.0](https://github.com/cedya77/aiometadata/compare/v1.9.0...v1.10.0) (2025-11-18)


### Features

* enrich kitsu episodes with IMDb data while preserving original IDs ([d24f13d](https://github.com/cedya77/aiometadata/commit/d24f13d0952b8a033dfe9548bfc4b1a79012c9ef))
* add option to keep RPDB posters for library items ([b009c00](https://github.com/cedya77/aiometadata/commit/b009c004f5a012880b8db3e6d61f388707d1779b))
* **getManifest:** extend TMDB year catalog range from 20 years to 1900-present ([f55575e](https://github.com/cedya77/aiometadata/commit/f55575ea298cb94c7529e97837b1c859938a8125))


### Bug Fixes

* **index:** add CORS headers to manifest.json endpoints to prevent browser blocking ([d0cda45](https://github.com/cedya77/aiometadata/commit/d0cda456a468ebdf756218cfc6992a2cc496503f))


### Performance Improvements

* add in-memory config cache ([f0f2a59](https://github.com/cedya77/aiometadata/commit/f0f2a5918494105af65c039f6c46ee8a2eef14de))
* use MGET in reconstructMetaFromComponents ([f7e58e1](https://github.com/cedya77/aiometadata/commit/f7e58e1e82aaf38d996284ead538678e15d69a4e))

## [1.9.0](https://github.com/cedya77/aiometadata/compare/v1.8.3...v1.9.0) (2025-11-16)


### Features

* **ui:** Add auto-detect page size for custom manifests and optimize logging ([3777115](https://github.com/cedya77/aiometadata/commit/3777115c9d07647807ae236601dbc1ab7c61fb39))


### Bug Fixes

* **cast credits:** add option to let the user force latin cast name when using a non EN lang for TMDB meta ([9963ad5](https://github.com/cedya77/aiometadata/commit/9963ad5cad744ffe22ddd3a3794d5299c37aa8dc))

## [1.8.3](https://github.com/cedya77/aiometadata/compare/v1.8.2...v1.8.3) (2025-11-14)


### Bug Fixes

* **cache:** fix cache key mismatch in meta wrap smart by aligning animeIdProvider logic ([c4571e4](https://github.com/cedya77/aiometadata/commit/c4571e44444fa1fa54379d63638faa8b79358f7e))
* **tvdb genre:** TVDB genres pagination by using correct pageSize from env var ([1fef78e](https://github.com/cedya77/aiometadata/commit/1fef78e467d24a54543d98f4a92d6644620b66fa))

## [1.8.2](https://github.com/cedya77/aiometadata/compare/v1.8.1...v1.8.2) (2025-11-13)


### Bug Fixes

* TVDB collections movies-only, TVMaze schedule improvements ([c47746a](https://github.com/cedya77/aiometadata/commit/c47746ab4c451eb1cf94357d79e69e0ae7df9656))

## [1.8.1](https://github.com/cedya77/aiometadata/compare/v1.8.0...v1.8.1) (2025-11-12)


### Bug Fixes

* **tvmaze:** Update schedule API from web to full and adapt new response structure ([27cbacd](https://github.com/cedya77/aiometadata/commit/27cbacd21b1651335fa89659b92f349250104810))

## [1.8.0](https://github.com/cedya77/aiometadata/compare/v1.7.2...v1.8.0) (2025-11-12)


### Features

* add more providers ([7bf97b9](https://github.com/cedya77/aiometadata/commit/7bf97b976411b602e09395573ef81922a62ffab1))
* **catalogs:** Add per-catalog randomization controls ([9ac3d89](https://github.com/cedya77/aiometadata/commit/9ac3d89b33bcfd07be7715d19ed17b2f068a2448))
* **catalogs:** Add TVMaze daily schedule catalog ([15e928b](https://github.com/cedya77/aiometadata/commit/15e928b0c00342f6772def0bc473e6ef2c6a7776))
* start implementing mdblist watch status ([c391f88](https://github.com/cedya77/aiometadata/commit/c391f8848943dc16e9c3abeedc99d72f47ed4ed5))
* **ui:** Track Kitsu search performance and improve nav ([01f66aa](https://github.com/cedya77/aiometadata/commit/01f66aa95a92d056bd6d9a8cdacb1d8fb5fafd90))


### Bug Fixes

* **cache:** Handle cache key correctly for anime id provider when using imdb id for anime ([36453f3](https://github.com/cedya77/aiometadata/commit/36453f391c1be15dbf122cbdb103cc61dc938dec))
* **cache:** Track meta cache hits correctly and prevent double-counting misses ([4b59363](https://github.com/cedya77/aiometadata/commit/4b5936368aaaee14cfbd61037c0b52680008450e))
* **custom catalogs:** allow configuring page size for imports to fix pagination for addons that use less than 100 as page size ([683205b](https://github.com/cedya77/aiometadata/commit/683205ba45109bfc8047d333a9b1f636a4515468))
* decouple html blurb from user configs ([2ed1aeb](https://github.com/cedya77/aiometadata/commit/2ed1aeb3100667c1f37846d16cbcf1a86bfb1e11))
* decouple html blurb from user configs ([fdedabb](https://github.com/cedya77/aiometadata/commit/fdedabb779179356540ce08449f2b3ddec75cdba))
* make persons search strict ([02cf696](https://github.com/cedya77/aiometadata/commit/02cf69696478dfeb7d93ee8c7e60bcbc0edf0053))
* make persons search strict ([4d253b2](https://github.com/cedya77/aiometadata/commit/4d253b25b6f367b5f4c7909ca5040bd009b120b2))
* make skygo region agnostic ([ca8c08c](https://github.com/cedya77/aiometadata/commit/ca8c08cb0eddba3b8a3b12bb5958809a4dbe8c23))
* **meta:** prevent getMeta from being called if imdb id isnt found when Use IMDb ID for Catalog/Search for Series is On ([f566121](https://github.com/cedya77/aiometadata/commit/f566121f768e2c9787d8e38182c733f268b40074))
* **search:** Improve search provider labeling ([c22ee47](https://github.com/cedya77/aiometadata/commit/c22ee47afae5dbe946ab85632b609a6b1b956d19))
* **tmdb meta:** Use original_title when user language matches original language and no translation exists ([56ff1e1](https://github.com/cedya77/aiometadata/commit/56ff1e1975d2cf7621c05dc06a93b25e20d01303))

## [1.7.2](https://github.com/cedya77/aiometadata/compare/v1.7.1...v1.7.2) (2025-11-05)


### Bug Fixes

* **meta:** fix anime id condition issue ([9a22e0e](https://github.com/cedya77/aiometadata/commit/9a22e0e8ce3b9bdfead2ac53ddae77f9958a3986))

## [1.7.1](https://github.com/cedya77/aiometadata/compare/v1.7.0...v1.7.1) (2025-11-05)


### Bug Fixes

* **meta:** fix undefined certificationsData and empty ids handling ([7c66530](https://github.com/cedya77/aiometadata/commit/7c665305d9322e92959bcdd15d62948218729a5e))

## [1.7.0](https://github.com/cedya77/aiometadata/compare/v1.6.4...v1.7.0) (2025-11-04)


### Features

* **custom-manifest:** Add proxy endpoint for Docker network manifest URLs ([9083e12](https://github.com/cedya77/aiometadata/commit/9083e12c4bb2f842df30d3874747e9a86e8d344e))


### Bug Fixes

* **art:** RPDB handling and improve error resilience ([eafe942](https://github.com/cedya77/aiometadata/commit/eafe9422ab0d23e62bfdd1afbc013fb2b8b757ec))
* **tmdb trailers:** fix multilingual trailers logic ([cc4a088](https://github.com/cedya77/aiometadata/commit/cc4a088ad7a98b5d8e98a926ccfd6c3cd4eda4b0))
* **trakt up next:** fix issue with caching ([b44be7c](https://github.com/cedya77/aiometadata/commit/b44be7c81bad2bd6c7550b8cea63ec8d8678dd01))

## [1.6.4](https://github.com/cedya77/aiometadata/compare/v1.6.3...v1.6.4) (2025-11-04)


### Bug Fixes

* **anime meta & fanart:** fix self-inflicted initialization issue and re apply langugage selection logic to fanart ([af1b8ec](https://github.com/cedya77/aiometadata/commit/af1b8ec459c498681087a7124a2bf71413e9dd16))
* finetune person's search logic further ([#99](https://github.com/cedya77/aiometadata/issues/99)) ([5df4cc6](https://github.com/cedya77/aiometadata/commit/5df4cc6a29a2d8adb43ba611f48aefcd404b9e39))

## [1.6.3](https://github.com/cedya77/aiometadata/compare/v1.6.2...v1.6.3) (2025-11-04)


### Bug Fixes

* **anime movie:** adapt ids to new anime movie id mapping ([0ca12cc](https://github.com/cedya77/aiometadata/commit/0ca12cc5832f5c50662ccf73b78cba101d1c4ada))
* **fanart:** adapt changes from fanart api ([8b3d006](https://github.com/cedya77/aiometadata/commit/8b3d006d3e60da1b3aee99bd9b193c2f1a288324))

## [1.6.2](https://github.com/cedya77/aiometadata/compare/v1.6.1...v1.6.2) (2025-11-03)


### Bug Fixes

* **anime meta:** issue with anime override & filter out null names from cast/crew ([f5e633d](https://github.com/cedya77/aiometadata/commit/f5e633d1135d2d1b925797379fe27134199278db))

## [1.6.1](https://github.com/cedya77/aiometadata/compare/v1.6.0...v1.6.1) (2025-11-03)


### Bug Fixes

* **meta:** anime ID provider check logic ([17c7828](https://github.com/cedya77/aiometadata/commit/17c7828051d208062c873f41c23901e31e9d9ae0))

## [1.6.0](https://github.com/cedya77/aiometadata/compare/v1.5.0...v1.6.0) (2025-11-03)


### Features

* add clear expire keys button to dash ([2c17c48](https://github.com/cedya77/aiometadata/commit/2c17c481c48aef457ebcec48ade6b60bd3c76c68))
* Add granular RPDB control, anime movie mappings, and catalog warmer fixes ([3bef3b1](https://github.com/cedya77/aiometadata/commit/3bef3b197726789a46aba8d0332e674198053ef5))


### Bug Fixes

* missing 'None' genre option for tmdb.popular when showInHome is false ([2c17c48](https://github.com/cedya77/aiometadata/commit/2c17c481c48aef457ebcec48ade6b60bd3c76c68))
* use CATALOG_LIST_ITEMS_SIZE for MDBList catalogs in warmer ([5527d74](https://github.com/cedya77/aiometadata/commit/5527d748c474eeeb3fad613fed5ad9961b93789b))

## [1.5.0](https://github.com/cedya77/aiometadata/compare/v1.4.1...v1.5.0) (2025-10-28)


### Features

* **config:** Update CACHE_WARMUP_UUID to CACHE_WARMUP_UUIDS for multi-UUID support ([61d6cb6](https://github.com/cedya77/aiometadata/commit/61d6cb6503c6566d697b7a406a5d763606f2a628))
* **search:** Add search provider renaming and reordering functionality ([0512bc8](https://github.com/cedya77/aiometadata/commit/0512bc8d45156fe0697243c01cff635655c32c27))


### Bug Fixes

* catalog warmer stats accumulation ([fb9cc26](https://github.com/cedya77/aiometadata/commit/fb9cc26b4a681b78cd3fad00b1a23a3b7b3ad22e))
* poster fallback logic on tmdb ([6a6938e](https://github.com/cedya77/aiometadata/commit/6a6938ea9c43383d0028aec9063c9e5222253287))
* poster fallback logic on tmdb ([e7a9bef](https://github.com/cedya77/aiometadata/commit/e7a9bef6574150740707d15e95661c27a6e4813a))

## [1.4.1](https://github.com/cedya77/aiometadata/compare/v1.4.0...v1.4.1) (2025-10-24)


### Bug Fixes

* persons search logic ([269e9d1](https://github.com/cedya77/aiometadata/commit/269e9d1da51337e7ec8cc13bbbbd2c6299f04013))
* persons search logic ([2b7535e](https://github.com/cedya77/aiometadata/commit/2b7535ea6fe3a302510ee828f827fa27a19b7219))

## [1.4.0](https://github.com/cedya77/aiometadata/compare/v1.3.0...v1.4.0) (2025-10-24)


### Features

* add bulk editing actions to catalogs ([0f89eac](https://github.com/cedya77/aiometadata/commit/0f89eacf82feb8b580634846aef5279af97ef06c))
* add changelog modal and cache warming controls to ops tab with mobile responsiveness ([f74ad69](https://github.com/cedya77/aiometadata/commit/f74ad6940093ed092588273e18f05983f464c37a))
* add custom missing episode thumbnail ([f790504](https://github.com/cedya77/aiometadata/commit/f7905047e32d77ee6d8ae191cee96b7676c33660))
* Add custom TTL support for custom manifest integration ([4b274f5](https://github.com/cedya77/aiometadata/commit/4b274f5e5cc4f28691b15dc416c345544e018a78))
* add kitsu as anime meta/art provider ([79f6204](https://github.com/cedya77/aiometadata/commit/79f62047e46347627c1154a49327af7d5079ae8f))
* add MDBList watchlist integration with unified/non-unified support ([36daa55](https://github.com/cedya77/aiometadata/commit/36daa556369437f6bf343d40f88bc3f973277619))
* add prompt for missing mdblist api key in presets ([cde11ed](https://github.com/cedya77/aiometadata/commit/cde11edcea335837c501dbf4d2b63f591bad101e))
* Add user management system with admin controls ([351047f](https://github.com/cedya77/aiometadata/commit/351047f4fb4ec4186a6c59aee9b0bb4634fc9e2e))
* implement comprehensive catalog warming system ([ac5f0b9](https://github.com/cedya77/aiometadata/commit/ac5f0b97bc3195b736dd15059f18c74ddba567e4))
* support aliases for person's search ([6569cda](https://github.com/cedya77/aiometadata/commit/6569cda5906cba211e86c0591fc453ad4ecf68e0))


### Bug Fixes

* -tmdb should now respect language priority when getting posters during search. - Added release year condition to nameToImdb ([daa08cc](https://github.com/cedya77/aiometadata/commit/daa08cc795dfd45b14347e2cb97b246822d14e7b))
* age rating filtering ([d16c024](https://github.com/cedya77/aiometadata/commit/d16c02431a2ae9c513825573faafe42befbf79f0))
* apply content rating on trending tmdb catalog ([d0d5513](https://github.com/cedya77/aiometadata/commit/d0d5513c183b4dbe745ca2490bd95b238cf3b991))
* apply content rating on trending tmdb catalog ([8c27189](https://github.com/cedya77/aiometadata/commit/8c27189c0bc8b0a0b232ab407d5662a1e81a3d76))
* apply same logic to dashboard ([fc2260b](https://github.com/cedya77/aiometadata/commit/fc2260b5076c4601dca6662e007abe9bffb9e301))
* apply same logic to dashboard ([41f0bfe](https://github.com/cedya77/aiometadata/commit/41f0bfe121d635d9d6a23adfa5482d7b09be0075))
* **custom catalogs:** correct pagination logic to handle any page size and prevent repeated results ([89f5d35](https://github.com/cedya77/aiometadata/commit/89f5d357c1927706acad959c4ad45f1dadc63db7))
* make cache private for specific endpoints ([afa7967](https://github.com/cedya77/aiometadata/commit/afa796716d02cab62b1b9cf72f2cb7b028584e66))
* make cache private for specific endpoints ([5396976](https://github.com/cedya77/aiometadata/commit/5396976e1b12a386a6af1b4455f1cffdd51f3451))
* **stremthru:** correct configure URL generation for external button ([d25cf46](https://github.com/cedya77/aiometadata/commit/d25cf46810d2bbd8217a689bb30f13367cbbb743))

## [1.3.0](https://github.com/cedya77/aiometadata/compare/v1.2.1...v1.3.0) (2025-10-19)


### Features

* filter out TVDB features when no API key is available ([f9dd85e](https://github.com/cedya77/aiometadata/commit/f9dd85ec7694ded99765704b54b6947b89429b5c))
* implement dual content filtering system with cache invalidation ([b4b50ff](https://github.com/cedya77/aiometadata/commit/b4b50ffed4c0ac8144c5e5da27c7d5770874850c))

## [1.2.1](https://github.com/cedya77/aiometadata/compare/v1.2.0...v1.2.1) (2025-10-17)


### Bug Fixes

* prevent save button from being disabled during context loading ([02c3f0c](https://github.com/cedya77/aiometadata/commit/02c3f0c9ad69dc74dd1d4fb1870254be4eb9957b))

## [1.2.0](https://github.com/cedya77/aiometadata/compare/v1.1.0...v1.2.0) (2025-10-17)


### Features

* add CACHE_WARMUP_UUID env var for custom user config ([5f44698](https://github.com/cedya77/aiometadata/commit/5f44698c61c0b432029d31c7dcc5490f3e0c7eab))
* add external link icon for custom manifest catalogs that opens the manifest's /configure page in new tab when clicked ([559d139](https://github.com/cedya77/aiometadata/commit/559d1396d0bc8710e43fe7c568a3b7596f081321))
* add MAL catalog background warming ([cd19f5b](https://github.com/cedya77/aiometadata/commit/cd19f5b6015095234f763b91d289a8e4579e6b9f))
* add popular content cache warming system ([b3c8a23](https://github.com/cedya77/aiometadata/commit/b3c8a23449c9d5a08364019358ad8db97767cccd))
* add user list sort options for MDBList API ([6ee5d57](https://github.com/cedya77/aiometadata/commit/6ee5d576a73eebf721ab4ea494898079bd96f596))
* implement context-aware cache reconstruction ([56d5289](https://github.com/cedya77/aiometadata/commit/56d5289690aaac68f9f336deda6b3cc2d2eefa9b))
* make TVDB API key optional ([002e28e](https://github.com/cedya77/aiometadata/commit/002e28eb4cb4994cfd8016d1778bb7a691d558f9))
* parallelize server startup ([8380e2d](https://github.com/cedya77/aiometadata/commit/8380e2d4ea9b48ef3a6e591584d3b4ee1ca0a413))


### Bug Fixes

* add new custom catalogs at end of list to preserve existing catalog order ([ef9ad6e](https://github.com/cedya77/aiometadata/commit/ef9ad6eafe9fe78ddf0026bc99c12691bd560e6c))
* default catalogs name change not working ([5c77331](https://github.com/cedya77/aiometadata/commit/5c773315995851a5484a7292b4731737469c8d42))
* display type override revert and Dan Pyjama list filtering ([2fe4f39](https://github.com/cedya77/aiometadata/commit/2fe4f390eba6c78b59f22727d57c07b2db312d8c))
* improve MAL rate limiting and add configurable cache warming interval ([d465570](https://github.com/cedya77/aiometadata/commit/d465570b084b761391bbe9b23994fea5b27b5a44))
* meta reconstruction failing due to missing component during write and different components order in write and read ([bc9812f](https://github.com/cedya77/aiometadata/commit/bc9812f8cbc88a31163b79e73ca042eb817fcbf4))
* tvmaze air date not getting parsed properly ([625ee40](https://github.com/cedya77/aiometadata/commit/625ee40b70780121178c9c8ecb0d5cbfdf0ef41f))


### Reverts

* switch back to npm from Bun ([900e2df](https://github.com/cedya77/aiometadata/commit/900e2df589a8a6cdda13413e761899dfcba06d3b))

## [1.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.1...v1.1.0) (2025-10-14)


### Features

* add MAL Seasons catalog with dynamic season fetching ([3c4c42b](https://github.com/cedya77/aiometadata/commit/3c4c42bd2b6a195bae74719929ada3e62b2440a7))
* add support for Trakt Up Next and tun_ ID prefix ([97d55a2](https://github.com/cedya77/aiometadata/commit/97d55a2e43aecdf8858d21d9a080afb70f3acf7e))
* filter out most YT videos from TVDB ([3133a40](https://github.com/cedya77/aiometadata/commit/3133a40acf2b41d9c002072ed0aea6bbc2795f98))


### Bug Fixes

* improve metadata handling for anime episodes and TMDB images ([f0a371b](https://github.com/cedya77/aiometadata/commit/f0a371b49c23c6bb1f263a86b0f978a2f388b6d1))
* improve tvdb multilingual handling ([63fd49a](https://github.com/cedya77/aiometadata/commit/63fd49ae2d4d984f26e69f7edef519374bdf4d25))

## [1.0.1](https://github.com/cedya77/aiometadata/compare/v1.0.0...v1.0.1) (2025-10-12)


### Bug Fixes

* handle catalog IDs with colons in custom manifest imports ([14dcc2b](https://github.com/cedya77/aiometadata/commit/14dcc2b1ab5fd24c33607d077bf558e07d66efe1))

## [1.0.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.25.0.2.0...v1.0.0) (2025-10-11)


### Features

* add tvdb collections search ([7db7c2f](https://github.com/cedya77/aiometadata/commit/7db7c2fcb36b9070d1009ce9cd9666f0b458a960))
* fetch imdb ratings from imdb dataset ([70b0ab2](https://github.com/cedya77/aiometadata/commit/70b0ab23212ec38cba8ff1592285308cbbb89513))

## [1.0.0-beta.25.0.2.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.25.0.1.0...v1.0.0-beta.25.0.2.0) (2025-10-09)


### Bug Fixes

* Wrong file cache path, MAL poster bg, further tmdb meta edge cases and pagination for custom imported catalogs ([bdbc21b](https://github.com/cedya77/aiometadata/commit/bdbc21b9a5724ee8ba1aec0c8a2de7e406abdc43))

## [1.0.0-beta.25.0.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.25.0.0...v1.0.0-beta.25.0.1.0) (2025-10-08)


### Bug Fixes

* TMDB meta data edge case, Catalog id bug, and hide ST integration in the UI ([edf2e5c](https://github.com/cedya77/aiometadata/commit/edf2e5c030ddb3ac2f517e91cfdfbba5026c2f1b))

## [1.0.0-beta.25.0.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.2.3.0...v1.0.0-beta.25.0.0) (2025-10-08)


### Features

* add external manifests imports and improve presets ([dacbfa4](https://github.com/cedya77/aiometadata/commit/dacbfa49042d9e658123c9bc73afff4c1e08cac8))
* implement static genre system and enhance MDBList integration ([dba5847](https://github.com/cedya77/aiometadata/commit/dba5847788cdcb1bd66886fe4a9b47d59d77b708))
* improve preset system UX with clean slate behavior and visual enhancements ([62034bd](https://github.com/cedya77/aiometadata/commit/62034bd7741d3a99640be73914110dd5f87d7463))
* **ui:** Add config presets ([307c434](https://github.com/cedya77/aiometadata/commit/307c4342dd18957a7a0f95b91383b0e4d7d728fc))

## [1.0.0-beta.24.2.3.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.2.2.0...v1.0.0-beta.24.2.3.0) (2025-10-02)


### Bug Fixes

* **tvdb:** fix tvdb english art. ([b8e5995](https://github.com/cedya77/aiometadata/commit/b8e5995c7768b78366d34e280f2a4fb47be99fc7))

## [1.0.0-beta.24.2.2.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.2.1.0...v1.0.0-beta.24.2.2.0) (2025-10-02)


### Bug Fixes

* **meta:** fix anime movie meta when anime override is turned on as well as small meta issues fix. ([e1bcd5b](https://github.com/cedya77/aiometadata/commit/e1bcd5bd9e1077f2669bcb344b4b77336242813b))

## [1.0.0-beta.24.2.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.2.0...v1.0.0-beta.24.2.1.0) (2025-10-01)


### Bug Fixes

* **art && filters:** fix tmdb bg and digital release filter for search ([da56699](https://github.com/cedya77/aiometadata/commit/da56699ce5e1f5c8a36701074bb248e903c0204d))

## [1.0.0-beta.24.2.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.1.0...v1.0.0-beta.24.2.0) (2025-10-01)


### Features

* Add MDBList/StremThru genre caching and digital release filter ([044d57f](https://github.com/cedya77/aiometadata/commit/044d57f72107728e941f4a9b262e679c68ee3b14))
* **meta:** add digital release filtering to tvdb and imdb movie meta ([523c4d4](https://github.com/cedya77/aiometadata/commit/523c4d4d84d61bd1ff65285f0a04752464bf3fcc))


### Bug Fixes

* **logo:** fix lang selection for logo ([63feaf3](https://github.com/cedya77/aiometadata/commit/63feaf3c13d6ca680341b9453fc6f084eb2ed606))
* **tvdb genres:** set lang to eng  and country to usa ([8aebf83](https://github.com/cedya77/aiometadata/commit/8aebf834ceb6fa81548723255fdb408f1e03f132))

## [1.0.0-beta.24.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.24.0...v1.0.0-beta.24.1.0) (2025-09-28)


### Features

* add custom ttl for mdblist ([2ddba0a](https://github.com/cedya77/aiometadata/commit/2ddba0aef733e8290cd398065036f7a2e5720835))
* add SOCKS5 proxy support for MDBList API ([182b8e3](https://github.com/cedya77/aiometadata/commit/182b8e3d3dfa1236ce02c2e56581122ca300f3a3))
* **meta:** add fallback to imdbId for tvdb movies (useful for anime movies) ([cd2a698](https://github.com/cedya77/aiometadata/commit/cd2a698710d1f20768edffad85a8f2afed3b6c81))
* **meta:** add option to use imdb id with mal catalogs, enabling calendar functions and the like ([a6ed329](https://github.com/cedya77/aiometadata/commit/a6ed329abce0b769babaefafe76aab2afcc56e36))
* **tmdb catalog:** revamp popular catalog ([cec252a](https://github.com/cedya77/aiometadata/commit/cec252a8d4c458e4a9e1b732a79c1d17133d1b54))

## [1.0.0-beta.24.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.23.3.0...v1.0.0-beta.24.0) (2025-09-24)


### Features

* Add allowEpisodeMarking UI toggle and dashboard button ([69bd4a7](https://github.com/cedya77/aiometadata/commit/69bd4a7a2e4c6bc326e20c8688eef90b87e9f079))
* Add MDBList catalog sorting functionality with cache invalidation ([77a99a9](https://github.com/cedya77/aiometadata/commit/77a99a98a95958fc6eb53d2a71ed70f50802e413))
* add ratings object from mdblist when key is provided ([307d1df](https://github.com/cedya77/aiometadata/commit/307d1df46b2c7c749d015871257baf88e3ace89d))
* Add wiki mappings system with performance tracking ([272ff4a](https://github.com/cedya77/aiometadata/commit/272ff4a3e45a00ad141a4a66202b03ee9bc30050))
* **catalogs:** add option to modifiy catalog names ([17a5d0e](https://github.com/cedya77/aiometadata/commit/17a5d0e01d5c650ce3a745beab0a0e5b2f126a74))
* **catalogs:** get genres from ST lists ([164ab37](https://github.com/cedya77/aiometadata/commit/164ab379b77d338a30b59cadc49a839728a3a082))
* **http:** follow redirects in httpClient; fix nameToImdb await; safe certification write in trending and adapt to cinemeta api changes ([393dd94](https://github.com/cedya77/aiometadata/commit/393dd946a45d8e74d8d479185e55a54502aac214))
* **meta:** uniformize catalogs and search ids to use imdb ids to better integrate with stremio's ecosystem ([0eb8e58](https://github.com/cedya77/aiometadata/commit/0eb8e582057a94b0983168b512fd8bf9d5ee1702))
* optimize undici networking ([4cbf13c](https://github.com/cedya77/aiometadata/commit/4cbf13c192df640044e93a18621b0d3e3a259d0d))
* **search:** improve tmdb search and overall search times ([bf6dd20](https://github.com/cedya77/aiometadata/commit/bf6dd20d2e5914d347a6bb732227bc0723c1aca1))


### Bug Fixes

* Art provider ID resolution, logging levels, and dashboard metrics ([eedbd9d](https://github.com/cedya77/aiometadata/commit/eedbd9db10517597304c4892a25c8415698d8d99))
* **backgrounds:** remove space in append causing tmdb bgs to disappear ([5cd988b](https://github.com/cedya77/aiometadata/commit/5cd988b8a3d686d41b4645098623c40062f49cf9))
* dashboard cache performance color ([c8501e7](https://github.com/cedya77/aiometadata/commit/c8501e7fad9e38aad7703746d1c2e4185f1dbc24))
* **getTmdb:** pass config object correctly ([b5181ea](https://github.com/cedya77/aiometadata/commit/b5181ea38858d05adea9ebbe852d2a4ef5d3dd88))
* **getTmdb:** undo getTmdb.js getting reverted ([5ec99f2](https://github.com/cedya77/aiometadata/commit/5ec99f235a380f6abfb8b5a6e695ec0acf50f658))
* isRequired condition for ST ([ad37a33](https://github.com/cedya77/aiometadata/commit/ad37a33bdfc886d26f1fff2692fdbac26e225eaf))
* **mdblist:** fix genre filtering ([e4edbc3](https://github.com/cedya77/aiometadata/commit/e4edbc3327e6089f2bab4ca9caaf5069aa5ec78e))
* **meta:** defensive programming for null app_extras object ([6215756](https://github.com/cedya77/aiometadata/commit/6215756453edabf52ddc6d006bdedadd4a11bb79))
* **search:** properly pass url containing special characters to search from stremio. Thanks to code by [@0x](https://github.com/0x)Constant1 (https://github.com/0xConstant1) ([8f262dc](https://github.com/cedya77/aiometadata/commit/8f262dc65b8f72774fbcd30b1ef4a015c59c2673))
* **ST lists:** fix pagination and genre filtering ([38a4d00](https://github.com/cedya77/aiometadata/commit/38a4d0070f78aed101e545d49cb7facd8fda345d))
* **translations:** correctly fallback when selected language isnt available for titles and overviews ([27b9b9c](https://github.com/cedya77/aiometadata/commit/27b9b9c64234e0b06e2e9ed232e4a52d28369604))
* tvdb genres not resolving correctly to imdb and add none genres to ST catalogs when showInHome is false ([9272225](https://github.com/cedya77/aiometadata/commit/9272225c15224d135b3ce0f4666b51c4b466e0b9))
* **tvdb:** fix tvdb search response ([34fcd69](https://github.com/cedya77/aiometadata/commit/34fcd692ff54b36753f718b20e293fe1d4a857e8))

Note: TMDB search has been revamped with filtering, so please create an issue if you have trouble finding a title.

## [1.0.0-beta.23.3.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.23.2.0...v1.0.0-beta.23.3.0) (2025-09-11)


### Features

* add auto cache-cleanup to remove old id cache system and refactor stremthru ([4aaea96](https://github.com/cedya77/aiometadata/commit/4aaea9624a0ad452ddd202948f757a45bc9a6177))


### Bug Fixes

* **meta & art:** fix fallback to english for overview and title, as well as fanart posters for mal catalogs ([fb280a7](https://github.com/cedya77/aiometadata/commit/fb280a7420574f4ab14c9e63a3cf0e5cdae00c00))
* **meta:** fix overview language fallback for tmdb ([cbeb989](https://github.com/cedya77/aiometadata/commit/cbeb989f7d5edb05f7c0935cef8c22bac9b55e37))

## [1.0.0-beta.23.2.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.23.1.0...v1.0.0-beta.23.2.0) (2025-09-10)


### Bug Fixes

* improve cache management and fix spoiled mappings issues ([1d5cfb2](https://github.com/cedya77/aiometadata/commit/1d5cfb2be18f8f41f7231775f9aaa1a0b4ac19cb))

## [1.0.0-beta.23.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.23.0...v1.0.0-beta.23.1.0) (2025-09-09)


### Features

* unify catalog metadata by providing full meta for non-anime catalog sources ([0ec7aea](https://github.com/cedya77/aiometadata/commit/0ec7aea4cd195fe057edfe54075b55c3965da011))


### Bug Fixes

* **mdblist:** fix id converter initialization ([389f096](https://github.com/cedya77/aiometadata/commit/389f0965100faa2da5467015d8b4688630bd82e0))
* resolve search errors and improve admin dashboard ([af0c7db](https://github.com/cedya77/aiometadata/commit/af0c7dba8e0e58c1fccd35bd835e43df4720b3e3))
* **tvmaze:** fix tvmaze search ([1ea370c](https://github.com/cedya77/aiometadata/commit/1ea370c1c74bd1a5533369a26b682de6209ef5c6))

## [1.0.0-beta.23.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.22.1.0...v1.0.0-beta.23.0) (2025-09-07)


### Features

* Add English Art Only toggle to Art Providers ([3836037](https://github.com/cedya77/aiometadata/commit/38360375675512dc43bf262b547afc399e70f821))
* Implement granular art provider configuration with nested structure ([4c83a22](https://github.com/cedya77/aiometadata/commit/4c83a226e583e9cb1fb4edcfd15df264529f9b33))
* Major dashboard and metadata improvements ([7224f7d](https://github.com/cedya77/aiometadata/commit/7224f7dba8150afcac50e6940ecc7d0c0641e795))
* Migrate ID cache from SQLite to Redis with auto-migration ([dae15a9](https://github.com/cedya77/aiometadata/commit/dae15a9dead755bd7a947d95ad6dbff9245a0c90))


### Bug Fixes

* **artwork:** fix malformed tmdb anime artwork url ([233a00d](https://github.com/cedya77/aiometadata/commit/233a00d1daac0765fe88d0b9cb571040afd5f125))
* resolve MAL API pagination error and improve dashboard privacy ([1e718c4](https://github.com/cedya77/aiometadata/commit/1e718c416f33373da60c7d32cd361d46c6a300f3))

## [1.0.0-beta.22.1.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.22...v1.0.0-beta.22.1.0) (2025-09-01)


### Features

* implement comprehensive anime episode mapping system ([c0737f0](https://github.com/cedya77/aiometadata/commit/c0737f04bab301157e4c46886bce79618779abb4))


### Bug Fixes

* **meta & cache:** restore systematic anime detection ([7e80a53](https://github.com/cedya77/aiometadata/commit/7e80a5393f1e3973daf11f67dd1ccd69e5c63277))

## [1.0.0-beta.22](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.21...v1.0.0-beta.22) (2025-08-28)

## [1.0.0-beta.21](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.20...v1.0.0-beta.21) (2025-08-27)


### Features

* implement age rating filtering and fix cache invalidation issues ([81c129b](https://github.com/cedya77/aiometadata/commit/81c129b73a4358eb792c1aeb346be290c4a9a119))
* implement comprehensive cache invalidation and performance improvements ([d6a770a](https://github.com/cedya77/aiometadata/commit/d6a770af90795f62007ff38214570c9bad65aaac))
* merge PR from [@nolan1024](https://github.com/nolan1024) and enhance cache logging ([ddf1272](https://github.com/cedya77/aiometadata/commit/ddf1272e9633457e307fe7de1c65d39e32bff971))
* resolve IMDb IDs when TMDBs API cant provide ([57eb2d9](https://github.com/cedya77/aiometadata/commit/57eb2d90453d7b48980eaa9e1ddce13aa4f2ef6c))
* set TVDB as default anime art provider and fix decade catalog caching ([e236b64](https://github.com/cedya77/aiometadata/commit/e236b64e30b251307d35c45083c35e441bee928c))

## [1.0.0-beta.20](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.19.9...v1.0.0-beta.20) (2025-08-22)


### Features

* add manual workflow trigger ([578a876](https://github.com/cedya77/aiometadata/commit/578a876a99fb2adacafde2cb1fc80c5afbe0bf71))
* add SFW filter, new MAL catalogs, and enhance loading UI with metadata improvements ([d332596](https://github.com/cedya77/aiometadata/commit/d33259638c5302a94fbb60e5e1fbba31c9947d48))


### Bug Fixes

* update workflow to support beta patch versions ([f19f55b](https://github.com/cedya77/aiometadata/commit/f19f55b945f83648a2a8cd0d90317550cbe5d1af))

## [1.0.0-beta.19.9](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.19...v1.0.0-beta.19.9) (2025-08-21)

## [1.0.0-beta.19](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.18...v1.0.0-beta.19) (2025-08-20)


### Bug Fixes

* uniformize meta ids, which fixes mark as watch issues and fix streaming/MDBList catalog issues ([20ee3a7](https://github.com/cedya77/aiometadata/commit/20ee3a72408985e24b038ea1a5b4c2cb2f1bf2b4))

## [1.0.0-beta.18](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.17...v1.0.0-beta.18) (2025-08-19)


### Features

* **ui:** flat sortable catalog list, added  delete for mdblist/streaming catalogs ([8ef843f](https://github.com/cedya77/aiometadata/commit/8ef843f93f7935ba87a2014d2b663c27b79d085d))

## [1.0.0-beta.17](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.15...v1.0.0-beta.17) (2025-08-19)


### Bug Fixes

* Robust language fallback for TMDB/Fanart images, streaming catalog routing, and meta selection ([ed440e9](https://github.com/cedya77/aiometadata/commit/ed440e9375adb453ce4f8f9bd5e9d22e067e0aa1))

## [1.0.0-beta.16](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.15...v1.0.0-beta.16) (2025-08-18)

### [1.0.1-beta.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.15...v1.0.1-beta.0) (2025-08-18)

## [1.0.0](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.15...v1.0.0) (2025-08-18)

## [1.0.0-beta.15](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.14...v1.0.0-beta.15) (2025-08-11)

## [1.0.0-beta.15](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.14...v1.0.0-beta.15) (2025-08-11)

## [1.0.0-beta.14](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.13...v1.0.0-beta.14) (2025-08-11)


### Features

* **config:** Improve Kitsu Mapping, add intagrate MDBLists  and add TVDB genre catalogs ([0254c50](https://github.com/cedya77/aiometadata/commit/0254c50797e4cc3773d7bd68caacff0776ba7e12))

## [1.0.0-beta.13](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.12...v1.0.0-beta.13) (2025-08-08)


### Bug Fixes

* **meta:** re-add tvdb meta that was stupidly removed because i forgot and else condition ([baf04eb](https://github.com/cedya77/aiometadata/commit/baf04eb7751eb64b80e851c0a9b083b4e710d104))
* **meta:** remove kitsu season number from id ([08fd8de](https://github.com/cedya77/aiometadata/commit/08fd8de25a89584445eb172a0075baf26fada4e6))
* **package:** fix package version ([b975390](https://github.com/cedya77/aiometadata/commit/b975390c8dffa48e79f49b72fe1093761e56b068))

## [1.0.0-beta.14](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.12...v1.0.0-beta.14) (2025-08-08)


### Bug Fixes

* **meta:** re-add tvdb meta that was stupidly removed because i forgot and else condition ([baf04eb](https://github.com/cedya77/aiometadata/commit/baf04eb7751eb64b80e851c0a9b083b4e710d104))
* **meta:** remove kitsu season number from id ([08fd8de](https://github.com/cedya77/aiometadata/commit/08fd8de25a89584445eb172a0075baf26fada4e6))

## [1.0.0-beta.13](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.12...v1.0.0-beta.13) (2025-08-07)


### Bug Fixes

* **meta:** remove kitsu season number from id ([08fd8de](https://github.com/cedya77/aiometadata/commit/08fd8de25a89584445eb172a0075baf26fada4e6))

## [1.0.0-beta.12](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.11...v1.0.0-beta.12) (2025-08-07)


### Bug Fixes

* **meta:** remove kitsu season number from id ([fd0a79a](https://github.com/cedya77/aiometadata/commit/fd0a79a611feaa141d99b59d6b231ce30b3b2ae3))

## [1.0.0-beta.11](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.10...v1.0.0-beta.11) (2025-08-07)


### Features

* **search:** Split anime search and add Kitsu ID mapping to tv groups ([2d56c84](https://github.com/cedya77/aiometadata/commit/2d56c847d5ec3d812651efdb8cec6f684c24ad5d))

## [1.0.0-beta.10](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.9...v1.0.0-beta.10) (2025-08-07)

## [1.0.0-beta.9](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.8...v1.0.0-beta.9) (2025-08-07)

## [1.0.0-beta.8](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.7...v1.0.0-beta.8) (2025-08-07)


### Features

* Add addon version to UI and prefix option ([549589f](https://github.com/cedya77/aiometadata/commit/549589f3c7dde40d04a7fedf77d2f5e1a044ef22))

## [1.0.0-beta.7](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.6...v1.0.0-beta.7) (2025-08-06)


### Features

* **meta:** switch anime catalog type to movie/series ([63e9a0d](https://github.com/cedya77/aiometadata/commit/63e9a0dffd3d955951b71626ae5e44a1e9fdf0d7))

## [1.0.0-beta.6](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.5...v1.0.0-beta.6) (2025-08-06)


### Features

* **search && meta:** Add TVmaze as a search and meta provider ([cea81a2](https://github.com/cedya77/aiometadata/commit/cea81a2b9391e76d52ea1c1f74cf5cdc7792aa22))

## [1.0.0-beta.5](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.4...v1.0.0-beta.5) (2025-08-05)


### Bug Fixes

* **search && meta:** fix config issue and id resolving to tvdb ([56350c3](https://github.com/cedya77/aiometadata/commit/56350c38d094f6a7428047c43c9ba3e6a8a190a2))

## [1.0.0-beta.4](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.3...v1.0.0-beta.4) (2025-08-05)


### Bug Fixes

* **meta & config:** fix persistent config issues and imdb mapping ([72af6f9](https://github.com/cedya77/aiometadata/commit/72af6f9c77e7e5c212072f519da325146561363b))

## [1.0.0-beta.3](https://github.com/cedya77/aiometadata/compare/v1.0.0-beta.2...v1.0.0-beta.3) (2025-08-05)


### Features

* **catalogs:** lazy loading ([b9cbb67](https://github.com/cedya77/aiometadata/commit/b9cbb67085f188246742eb261828ba1b13376a1f))


### Bug Fixes

* **packages:** update git url ([b9e67b5](https://github.com/cedya77/aiometadata/commit/b9e67b5f42bfb96d4a09f03272bdafa969bf1c21))

## [1.0.0-beta.2](https://github.com/mrcanelas/tmdb-addon/compare/v1.0.0-beta.1...v1.0.0-beta.2) (2025-08-05)


### Bug Fixes

* **rpdb:** correctly pass api key ([4e90248](https://github.com/mrcanelas/tmdb-addon/commit/4e90248bcfda30d41f36c547381e96ed57184209))

## [1.0.0-beta.1](https://github.com/mrcanelas/tmdb-addon/compare/v1.0.0-beta.0...v1.0.0-beta.1) (2025-08-04)


### Features

* **ui:** implement env var injection and fix theme/styling issues ([649fd86](https://github.com/mrcanelas/tmdb-addon/commit/649fd86f7fe4a074bba5720c780dd1cb88368a64))

## [1.0.0-beta.0](https://github.com/mrcanelas/tmdb-addon/compare/v5.0.1-dev.0...v1.0.0-beta.0) (2025-08-04)
