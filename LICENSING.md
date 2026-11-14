# Licensing

AIOMetadata v4 is **source-available**. Its source is public, and most of it,
the core, is free software under the GNU Affero General Public License v3.0
or later (AGPL-3.0-or-later). The v4 feature modules (the Jellyfin server,
the trackers and the dashboard, plus the other files listed below) are under
the Functional Source License, Version 1.1, ALv2 Future License
(FSL-1.1-ALv2). Each release of those modules becomes Apache-2.0 two years
after it is published.

The core imports the feature modules directly, so the program as shipped needs
both parts. The whole program is therefore not open source, even though the
core's own files are.

The licensor of both parts is **cedya77**.

- [`LICENSE`](LICENSE): the AGPL-3.0 text.
- [`LICENSE-FSL.md`](LICENSE-FSL.md): the FSL-1.1-ALv2 text.
- [`NOTICE`](NOTICE): copyright notices for earlier and bundled work, and
  third-party material that neither license covers.
- [`TRADEMARKS.md`](TRADEMARKS.md): use of the AIOMetadata name and logo.

Every source file starts with an SPDX header naming its license. A CI check
keeps the headers in line with the map below.

## Which license covers what

**FSL-1.1-ALv2.** The paths in this list (a path ending in `/**` covers the
whole folder):

<!-- fsl-paths:start -->
- `addon/lib/jellyfin/**`
- `addon/lib/trackers/**`
- `configure/src/components/dashboard/**`
- `configure/src/components/jellyfin/**`
- `addon/lib/catalogKeyArgs.ts`
- `addon/lib/collectionBuilder/homeOrder.ts`
- `addon/lib/collectionBuilder/mergeModes.ts`
- `addon/lib/dashboardApp.ts`
- `addon/lib/featureDatabase.ts`
- `addon/lib/playSources.ts`
- `addon/lib/tmdbSeriesRuntime.ts`
- `addon/lib/stremioEventStatus.ts`
- `addon/lib/stremioEvents.ts`
- `addon/lib/trackerActivity.ts`
- `addon/utils/titleMatch.ts`
- `addon/utils/yieldEvery.ts`
- `configure/src/components/MergeModePicker.tsx`
- `configure/src/components/sections/CollectionListCard.tsx`
- `configure/src/components/sections/JellyfinSettings.tsx`
- `configure/src/components/sections/PeopleSettings.tsx`
- `configure/src/components/sections/RowOptionsDialog.tsx`
- `configure/src/components/sections/WatchTrackingSettings.tsx`
- `configure/src/components/settings/JellyfinGlyph.tsx`
- `configure/src/components/settings/Segmented.tsx`
- `configure/src/components/settings/StepTimeline.tsx`
- `configure/src/components/users/Face.tsx`
- `configure/src/components/users/HouseholdUsers.tsx`
- `configure/src/components/users/InstallLinks.tsx`
- `configure/src/hooks/useDashboardQueries.ts`
- `configure/src/hooks/useJellyfinServer.ts`
- `configure/src/hooks/useOwnPageStatus.ts`
- `configure/src/hooks/useStremioLinkStatus.ts`
- `configure/src/lib/dashboardApp.ts`
- `configure/src/lib/dashboardRoute.ts`
- `configure/src/lib/jellyfinClient.ts`
- `configure/src/lib/nuvioAccount.ts`
- `configure/src/lib/ownPage.ts`
- `configure/src/lib/phoneSheet.ts`
- `configure/src/lib/radioKeys.ts`
- `configure/src/lib/stremioAccount.ts`
<!-- fsl-paths:end -->

These are the folders and files v4 adds over v3.8.3, plus two that carry
mostly v4 work: `addon/lib/featureDatabase.ts` holds the v4 feature modules'
tables and queries, split out of the core store (`addon/lib/databaseCore.ts`),
and `configure/src/hooks/useDashboardQueries.ts` serves only the dashboard.
Earlier versions of these folders and files shipped in v3.8.3 and before, and
those versions stay under the GPL-3.0 they were released with.

**Not covered by either license.** These files are third-party material,
listed in [`NOTICE`](NOTICE):

<!-- excluded-paths:start -->
- `public/jellyfin_icon.svg` (Jellyfin contributors, CC-BY-SA-4.0)
- `public/featured/**` (community collection designs, each its designer's; studio logos are trademarks)
- `configure/src/assets/ratings/**` (rating-source trademarks)
- `public/anilist_icon.png` (service or provider logo)
- `public/apple.webp` (service or provider logo)
- `public/betp.jpg` (service or provider logo)
- `public/blu.webp` (service or provider logo)
- `public/canal-plus.webp` (service or provider logo)
- `public/claro.webp` (service or provider logo)
- `public/crave.jpg` (service or provider logo)
- `public/criterionchannel.jpg` (service or provider logo)
- `public/crunchyroll.webp` (service or provider logo)
- `public/curiositystream.webp` (service or provider logo)
- `public/discovery-plus.webp` (service or provider logo)
- `public/disney.webp` (service or provider logo)
- `public/funimation.webp` (service or provider logo)
- `public/globo.webp` (service or provider logo)
- `public/hayu.webp` (service or provider logo)
- `public/hbo.webp` (service or provider logo)
- `public/HIDIVE.png` (service or provider logo)
- `public/hotstar.webp` (service or provider logo)
- `public/hulu.webp` (service or provider logo)
- `public/letterboxd_icon.png` (service or provider logo)
- `public/magellan.webp` (service or provider logo)
- `public/mal_icon.png` (service or provider logo)
- `public/max.webp` (service or provider logo)
- `public/mdblist_icon.png` (service or provider logo)
- `public/mubi.jpg` (service or provider logo)
- `public/netflix.webp` (service or provider logo)
- `public/netflixkids.webp` (service or provider logo)
- `public/nlziet.webp` (service or provider logo)
- `public/paramount.webp` (service or provider logo)
- `public/peacock.webp` (service or provider logo)
- `public/pmdb_icon.svg` (service or provider logo)
- `public/prime.webp` (service or provider logo)
- `public/rakuten_viki.webp` (service or provider logo)
- `public/skygo.jpg` (service or provider logo)
- `public/skyshowtime.webp` (service or provider logo)
- `public/sonyliv.webp` (service or provider logo)
- `public/starz.jpg` (service or provider logo)
- `public/stremio.png` (service or provider logo)
- `public/stremio_icon.png` (service or provider logo)
- `public/tmdb_icon.png` (service or provider logo)
- `public/trakt_icon.png` (service or provider logo)
- `public/tvdb_icon.png` (service or provider logo)
- `public/videoland.webp` (service or provider logo)
- `public/wow.jpg` (service or provider logo)
- `public/youtube.webp` (service or provider logo)
- `public/zee5.webp` (service or provider logo)
<!-- excluded-paths:end -->

**AGPL-3.0-or-later, with the additional permission below.** Everything else:
the metadata engine, catalogs and the configure UI.

## Additional permission for the core

The core's SPDX headers read
`AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking`. That addition is
this text:

> Additional permission under GNU AGPL version 3 section 7. If you modify this
> Program, or any covered work, by linking or combining it with the
> AIOMetadata Feature Modules (the files that `LICENSING.md` lists as licensed
> under the Functional Source License, Version 1.1, ALv2 Future License), or a
> modified version of those modules, containing parts covered by the terms of
> that license, the licensors of this Program grant you additional permission
> to convey the resulting work. Corresponding Source for a non-source form of
> such a combination shall include the source code for the parts of the
> Feature Modules used as well as that of the covered work. The Feature
> Modules remain under their own terms, and nothing here grants any right to
> them.

## Older releases

Releases up to and including v3.8.3 keep the licenses they were published
under (GPL-3.0 for v3.x since 11 April 2026; MIT or Apache-2.0 before that).
Nothing here changes them.

## Plain-language answers

This section explains the licenses; the license texts decide.

**Can I run AIOMetadata for myself?** Yes. Running it for your own use, your
household's or your organization's internal use is a permitted purpose under
the FSL, and the AGPL allows any use.

**Can I modify it?** Yes. If you let people use a modified core over a network,
the AGPL requires you to offer them its source. Modified feature modules stay
under the FSL.

**Can I offer AIOMetadata v4 as a hosted service?** Not as a commercial
product or service, until the release you run turns Apache-2.0. The FSL calls
that a Competing Use: making the software available to others in a commercial
product or service with the same or substantially similar functionality. See
the licensor's note below.

**What can a paid host still run?** v3.8.3 and earlier, under their own
licenses. Each v4 release from two years after it is published, under
Apache-2.0. And any software a customer installs for themselves on a server
they rent.

**Can I help someone else set up their own instance, for a fee?** Yes. The
FSL permits professional services to a licensee running the software under
its terms: consulting, setup, support or training for an instance the customer
runs.

**When does a release become Apache-2.0?** On the second anniversary of the
date that release is published. The release notes give the date.

**Can I contribute?** Yes. A contribution comes in under the license of each
file it touches, as the map above sets out, and the pull request template asks
you to confirm that. [`docs/contributing.md`](docs/contributing.md) has the
details.

## Licensor's note on hosting

This is how the licensor reads the FSL's terms for hosting, offered so that
nobody is surprised by it. A court has not yet ruled on the FSL.

Running instances of AIOMetadata v4 for paying customers, whether shared
between them or one per customer, is a Competing Use. It makes the software
available to others in a commercial product or service that offers the same
functionality. It is not "professional services that you provide to a
licensee": in that case the customer runs their own licensed instance and you
help them with it. When the host copies, runs and operates the software and
sells access to it as a product, the host is the one making the software
available, and the customer is not a licensee running it. Reading
professional services to cover hosting would leave the Competing Use clause
with nothing to apply to.

## Data providers

The licenses above cover this code only. The metadata providers it talks to
(TMDB, IMDb datasets, TVDB, Trakt, Simkl, MyAnimeList, AniList, Fanart.tv,
MDBList, Kitsu, MovieLens, Letterboxd, AI providers and others) have terms of
their own, and those terms bind whoever runs an instance. Several of them do
not allow commercial use without a separate agreement. See "Operator
obligations" in the [README](README.md).
