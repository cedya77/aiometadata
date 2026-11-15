# Data provider terms for operators

AIOMetadata's licenses cover its code, not the data it fetches. Whoever runs
an instance is bound by the terms of every provider that instance talks to.
Keys configured on the server (the `BUILT_IN_*_API_KEY` settings and the
instance's OAuth client ids) serve every user of the instance, so the
operator is the API licensee for them. Revenue thresholds below are measured
against the operator's service.

This page summarizes each provider's terms as published on **14 Nov 2026**.
It is not legal advice and terms change, so read the linked terms yourself
before you offer an instance to anyone else, and especially before you charge
for one. "Not verified" means no published terms could be found or reached on
that date.

## At a glance

| Provider | Used for | Commercial use | Must show users | Other key limits |
| --- | --- | --- | --- | --- |
| TMDB | metadata, images, search | **Not allowed** without a written agreement with TMDB | TMDB logo and notice (shown in the About dialog) | Cache TMDB content at most 6 months; no use to train AI models |
| IMDb datasets | IMDb ratings | **Not allowed**: "personal and non-commercial use" only | — | — |
| TheTVDB | metadata, art | Commercial projects contact TVDB sales; discounts for free and open-source projects | Attribution **with a link to TheTVDB.com** to end users viewing its metadata (shown in the About dialog) | — |
| Trakt | catalogs, tracking, scrobbling | Allowed on the free Standard tier | A line saying the app uses Trakt but is not endorsed or certified by Trakt (shown in the About dialog) | 500 GET per 5 min per user (or per client id and IP unauthenticated), 1 write/s; no reusable catalog copies |
| Simkl | catalogs, tracking | Free under $150/month revenue; a commercial license at or above it | A visible "Simkl" attribution (shown in the About dialog), ideally linking to each item's Simkl page; Trending sections titled with "Simkl" | 10 GET/s and 1 POST/s per client id and per user token |
| MyAnimeList (official API) | anime lists, tracking | Earning money needs MyAnimeList's written authorization | Credit MyAnimeList as the source | Your own Client ID, never shared; scraping prohibited; delete removed content within 24 h |
| AniList | anime catalogs, lists | Free under $150/month revenue; a commercial license above it (contact@anilist.co) | — | 90 requests/min (temporarily 30/min) |
| TVmaze | schedules, episodes | Allowed: data is CC BY-SA 4.0 | Credit TVmaze with a link (shown in the About dialog); share-alike applies to the data | 20 calls per 10 s per IP |
| Gemini (Google) | AI search, recommendations | Allowed under Google's API terms | — | Users must be 18+; only paid tier for EEA, UK and Swiss users; unpaid-tier prompts may train Google's models |
| OpenRouter | AI search, recommendations | Allowed, but **no reselling of model access** | — | Users must be 18+; key holder responsible for all use |
| MDBList | lists, ratings | Not verified | — | Quotas are per account and shared by all its keys: 1,000 requests/day free, more on paid tiers |
| Letterboxd | list import | — | — | **Terms prohibit scrapers and automated extraction** (see below) |
| Jikan (MyAnimeList data) | anime catalogs, search | Not verified | — | Scrapes MyAnimeList, whose agreement prohibits scraping (see below) |
| Fanart.tv, Kitsu, RPDB, Top Posters, MovieLens, PublicMetaDB, AniDB, AniSkip, IntroDB, Cinemeta | art, ratings posters, anime data, skip markers, meta | Not verified | — | Check each provider's own terms |

## Details

### TMDB
- The standard API license "does not permit any commercial use of TMDB, the
  TMDB APIs, or TMDB Content". Commercial use needs a written agreement with
  TMDB, which decides what counts as commercial.
- Show the TMDB logo, less prominent than your own branding, and the notice
  that the product "uses TMDB and the TMDB APIs but is not endorsed,
  certified, or otherwise approved by TMDB". The README and the configure
  page's About dialog carry both.
- Do not cache TMDB content for longer than 6 months. This includes the
  metadata cache, the meta cold store and the image cache: keep their
  retention under six months.
- TMDB data may not be used to train machine-learning or AI models.
- Source: [TMDB API Terms of Use](https://www.themoviedb.org/api-terms-of-use)
  (last updated 20 Oct 2023).

### IMDb datasets
- The datasets at `datasets.imdbws.com` are "available for access to
  customers for personal and non-commercial use". An instance run
  commercially must not use the IMDb ratings feature. Businesses are pointed
  to IMDb's licensing team.
- The IMDb title-suggestion endpoint the search uses is undocumented and was
  not checked.
- Source: [IMDb non-commercial datasets](https://data.imdb.com/non-commercial-datasets/).

### TheTVDB
- "Attribution with a direct link to TheTVDB.com must be displayed to end
  users viewing metadata from our API", unless TheTVDB approves otherwise.
  Its sample wording: "Metadata provided by TheTVDB. Please consider adding
  missing information or subscribing."
- The API serves commercial and individual projects; ask TheTVDB's sales
  team about commercial pricing. Free and open-source projects get
  discounts.
- Source: [TheTVDB API information](https://thetvdb.com/api-information).

### Trakt
- Trakt's API Use Policy (updated 20 Oct 2026) permits free and paid apps,
  and the Standard tier is free for commercial use. Apps must state that they
  use Trakt but are not endorsed or certified by Trakt. The logo is optional.
  Do not build reusable copies of Trakt's catalog, and stop using Trakt
  artwork when an integration ends.
- Rate limits on Standard apps: 1 write per second and 500 GET calls per 5
  minutes per authenticated user. Unauthenticated GETs: 500 per 5 minutes per
  client id and public IP. Premium developer accounts get higher limits.
- Sources: [Trakt rate limits](https://developer.trakt.tv/docs/rate-limiting),
  [Trakt Premium](https://developer.trakt.tv/docs/premium),
  [API Use Policy change](https://github.com/trakt/trakt-api/pull/1037).

### Simkl
- Free for non-commercial use, and for commercial apps under $150 a month.
  "If your app generates $150 / month or more, you must obtain a commercial
  license before continuing to use the API."
- Show a visible "Simkl" attribution, linking to the item's own Simkl page
  (`simkl.com/movies/<id>/<slug>`, `/tv/`, `/anime/`). A link in a privacy
  policy or an unbranded "More info" link does not count. Sections that show
  Simkl's Trending data must be titled with "Simkl".
- A tracker that syncs with other trackers may use Simkl's API only if it
  also offers Simkl login and sync. AIOMetadata does.
- 10 GET/s and 1 POST/s per client id and per user token. Sustained overuse
  can get the client id suspended without warning. Keep the client secret
  server-side.
- Source: [Simkl API rules](https://api.simkl.org/api-rules).

### MyAnimeList
- Earning "fees, profits, revenues or other funds" from an app needs
  MyAnimeList's written authorization. Free and open-source apps, including
  ones that take donations, are non-commercial.
- Each operator needs their own Client ID and must not share it. Do not store
  MyAnimeList users' personal data on the server. Content MyAnimeList removes,
  or a user asks to delete, must go within 24 hours.
- Scraping MyAnimeList is prohibited.
- Source: [MyAnimeList API License and Developer Agreement](https://myanimelist.net/static/apiagreement.html).

### Jikan
- Jikan is an unofficial MyAnimeList API that scrapes the MyAnimeList
  website. MyAnimeList's agreement prohibits scraping, so a commercial
  instance should set `JIKAN_ENABLED=false` (anime search and metadata then
  come from Kitsu, and MAL catalogs are dropped) or get MyAnimeList's
  permission.
- Source: [Jikan API documentation](https://docs.api.jikan.moe).

### AniList
- Commercial apps under $150 of revenue a month need no permission; above
  that, a commercial license (contact@anilist.co). Don't use the "AniList" or
  "AniChart" names on their own as your product's name.
- 90 requests per minute normally, with a burst limiter; AniList currently
  runs at 30 per minute while degraded.
- Source: [AniList terms of use](https://docs.anilist.co/guide/terms-of-use),
  [AniList rate limiting](https://docs.anilist.co/guide/rate-limiting).

### TVmaze
- Data is licensed CC BY-SA 4.0 and "can freely be used for any purpose" if
  TVmaze is credited (a link back is enough) and the share-alike terms are
  followed for the data.
- At least 20 calls every 10 seconds per IP. Set a descriptive User-Agent.
- Source: [TVmaze API](https://www.tvmaze.com/api).

### Letterboxd
- Letterboxd's terms say users "must not employ any robot, spider, scraper,
  deep-link, or other automated data gathering or extraction tool". The
  Letterboxd integration reads letterboxd.com pages to resolve lists, which
  these terms do not allow. Users turn it on per configuration; there is no
  instance-wide switch. An operator offering a commercial instance should get
  Letterboxd's permission (Letterboxd runs its own API program) or remove the
  integration.
- Source: [Letterboxd terms of use](https://letterboxd.com/legal/terms-of-use/).

### Gemini (Google)
- Users of an app built on the Gemini API must be 18 or older, and the app
  must not be directed at minors.
- For users in the EEA, Switzerland or the UK, only paid services may be
  used. Prompts sent on the unpaid tier may be used to improve Google's
  models and read by reviewers, so don't send personal data there.
- The operator is responsible for the generated content and the safety
  settings.
- Source: [Gemini API additional terms](https://aistudio.google.com/docs/terms).

### OpenRouter
- Users must be 18 or older. The key holder is responsible for all activity
  under the key, and must make sure users follow each model's own terms.
- Reselling access to models, or building a competing service, is
  prohibited.
- Source: [OpenRouter terms](https://openrouter.ai/terms).

### MDBList
- Request quotas are per account and "shared by all your API keys and apps":
  1,000 requests a day free, with paid tiers up to 250,000 a day, and a cap of
  1,000 reads and 300 writes per 5 minutes on every tier. A built-in MDBList
  key spends the operator's quota for every user.
- No terms on commercial use were found.
- Source: [MDBList API docs](https://docs.mdblist.com/docs/api).

### Not verified
Fanart.tv, Kitsu, RatingPosterDB, Top Posters, MovieLens, PublicMetaDB,
AniDB, AniSkip, IntroDB and Stremio's Cinemeta publish no API terms that
could be found or reached on 14 Nov 2026. Fanart.tv offers project and
personal keys. RatingPosterDB keys come with its paid tiers. MovieLens has no
public API: the integration signs in with the user's own MovieLens account.
Check each service's site before using it commercially.
