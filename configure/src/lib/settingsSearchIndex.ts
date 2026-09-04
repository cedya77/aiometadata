import type { SettingsSearchEntry } from './settingsSearch';

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  // ── General — configure/src/components/sections/GeneralSettings.tsx ──
  {
    id: 'general.language', section: 'general', anchor: 'language',
    label: 'Display Language',
    description: 'Language for titles and descriptions.',
    keywords: ['locale', 'translation', 'subtitle'],
  },
  {
    id: 'general.timezone', section: 'general', anchor: 'timezone',
    label: 'Timezone',
    description: 'For calendar-based features (e.g., Trakt Calendar).',
    keywords: ['time', 'utc', 'calendar'],
  },
  {
    id: 'general.castCount', section: 'general', anchor: 'cast-count',
    label: 'Cast Members',
    description: 'Number of cast members on details page.',
    keywords: ['actors', 'credits'],
  },
  {
    id: 'general.showPrefix', section: 'general', anchor: 'show-prefix',
    label: 'Show Prefix',
    description: 'Add prefix to catalogs.',
    keywords: ['name', 'title', 'catalog'],
  },
  {
    id: 'general.metaAttribution', section: 'general', anchor: 'show-meta-provider-attribution',
    label: 'Meta Attribution',
    description: 'Show "[Meta provided by Provider]" in overview.',
    keywords: ['credit', 'source'],
  },
  {
    id: 'general.displayAgeRating', section: 'general', anchor: 'display-age-rating',
    label: 'Display Age Rating',
    description: 'Show rating/certification in genres.',
    keywords: ['18+', 'certification', 'pg', 'mature'],
  },
  {
    id: 'general.includeAdult', section: 'general', anchor: 'adult-content',
    label: 'Include Adult Content',
    description: 'Show NSFW content in catalogs and search.',
    keywords: ['nsfw', 'porn', 'adult', 'explicit'],
  },
  {
    id: 'general.blurThumbs', section: 'general', anchor: 'blur-thumbs',
    label: 'Hide Episode Spoilers',
    description: 'Blur episode thumbnails to avoid spoilers.',
    keywords: ['blur', 'spoiler', 'thumbnail', 'preview'],
  },
  {
    id: 'general.showRateMeButton', section: 'general', anchor: 'show-rate-me-button',
    label: 'Show Rate Me Button',
    description: 'Display a rating button in meta pages.',
    keywords: ['rating', 'vote'],
  },
  {
    id: 'general.ratingPostersLibrary', section: 'general', anchor: 'enable-rating-posters-for-library',
    label: 'Rating Posters for Library',
    description: 'Keep rating posters for Continue Watching and Library items.',
    keywords: ['rpdb', 'poster', 'rating', 'library'],
  },
  {
    id: 'general.traktWatchTracking', section: 'general', anchor: 'trakt-watch-tracking',
    label: 'Trakt Checkin',
    description: 'Automatically sync your watch progress to external services when you play content.',
    keywords: ['scrobble', 'checkin', 'progress', 'watched'],
  },
  {
    id: 'general.simklWatchTracking', section: 'general', anchor: 'simkl-watch-tracking',
    label: 'Simkl Checkin',
    description: 'Automatically sync your watch progress to external services when you play content.',
    keywords: ['scrobble', 'checkin', 'progress', 'watched'],
  },
  {
    id: 'general.anilistWatchTracking', section: 'general', anchor: 'anilist-watch-tracking',
    label: 'AniList Tracking',
    description: 'Automatically sync your watch progress to external services when you play content.',
    keywords: ['scrobble', 'anime', 'progress', 'watched'],
  },
  {
    id: 'general.malWatchTracking', section: 'general', anchor: 'mal-watch-tracking',
    label: 'MyAnimeList Tracking',
    description: 'Automatically sync your watch progress to external services when you play content.',
    keywords: ['scrobble', 'anime', 'mal', 'progress', 'watched'],
  },
  {
    id: 'general.mdblistWatchTracking', section: 'general', anchor: 'mdblist-watch-tracking',
    label: 'MDBList Tracking',
    description: 'Automatically sync your watch progress to external services when you play content.',
    keywords: ['scrobble', 'progress', 'watched'],
  },
  {
    id: 'general.publicmetadbWatchTracking', section: 'general', anchor: 'publicmetadb-watch-tracking',
    label: 'PublicMetaDB Tracking',
    description: 'Automatically sync your watch progress to external services when you play content.',
    keywords: ['scrobble', 'progress', 'watched'],
  },

  // ── Integrations — sections/IntegrationsSettings.tsx:365-436 ──
  // Descriptions: the page has none per key, so use the section subtitle.
  {
    id: 'integrations.gemini', section: 'integrations', anchor: 'gemini',
    label: 'Google Gemini API Key',
    description: 'Connect to external services to enhance metadata quality.',
    keywords: ['api key', 'token', 'ai', 'google'],
  },
  {
    id: 'integrations.openrouter', section: 'integrations', anchor: 'openrouter',
    label: 'OpenRouter API Key',
    description: 'Connect to external services to enhance metadata quality.',
    keywords: ['api key', 'token', 'ai', 'llm'],
  },
  {
    id: 'integrations.tmdb', section: 'integrations', anchor: 'tmdb',
    label: 'TMDB API Key',
    description: 'Connect to external services to enhance metadata quality.',
    keywords: ['api key', 'token', 'themoviedb'],
  },
  {
    id: 'integrations.tvdb', section: 'integrations', anchor: 'tvdb',
    label: 'TheTVDB API Key',
    description: 'Connect to external services to enhance metadata quality.',
    keywords: ['api key', 'token'],
  },
  {
    id: 'integrations.fanart', section: 'integrations', anchor: 'fanart',
    label: 'Fanart.tv API Key',
    description: 'Connect to external services to enhance metadata quality.',
    keywords: ['api key', 'token', 'artwork', 'poster'],
  },
  {
    id: 'integrations.rpdb', section: 'integrations', anchor: 'rpdb',
    label: 'RPDB API Key',
    description: 'Connect to external services to enhance metadata quality.',
    keywords: ['api key', 'token', 'rating poster'],
  },
  {
    id: 'integrations.topPoster', section: 'integrations', anchor: 'topPoster',
    label: 'TOP Posters API Key',
    description: 'Connect to external services to enhance metadata quality.',
    keywords: ['api key', 'token', 'poster', 'artwork'],
  },
  {
    id: 'integrations.mdblist', section: 'integrations', anchor: 'mdblist',
    label: 'MDBList API Key',
    description: 'Connect to external services to enhance metadata quality.',
    keywords: ['api key', 'token', 'list'],
  },
  {
    id: 'integrations.publicmetadb', section: 'integrations', anchor: 'publicmetadb',
    label: 'PublicMetaDB API Key',
    description: 'Connect to external services to enhance metadata quality.',
    keywords: ['api key', 'token'],
  },

  // ── Filters — sections/FiltersSettings.tsx ──
  {
    id: 'filters.ageRating', section: 'filters', anchor: 'age-rating',
    label: 'Content Rating',
    description: 'Select the maximum content rating to display. All content rated higher than your selection will be hidden. For movies and series only.',
    keywords: ['18+', 'certification', 'pg', 'age', 'mature', 'parental'],
  },
  {
    id: 'filters.allowUnratedContent', section: 'filters', anchor: 'allow-unrated-content',
    label: 'Show Unrated Titles',
    description: 'Keep titles with no confirmed rating when a maximum content rating is set.',
    keywords: ['unrated', 'nr', 'not rated', 'certification', 'age', 'parental'],
  },
  {
    id: 'filters.sfw', section: 'filters', anchor: 'sfw-mode',
    label: 'Safe for Work (SFW) Mode',
    description: 'Enable to show only safe for work anime content. This will filter out adult content, some ecchi content, and other mature themes.',
    keywords: ['nsfw', 'ecchi', 'anime', 'adult'],
  },
  {
    id: 'filters.hideUnreleasedDigital', section: 'filters', anchor: 'hide-unreleased-digital',
    label: 'Hide Unreleased Movies in Catalogs',
    description: "Hide movies that haven't been released digitally yet. Applies to movie catalogs only.",
    keywords: ['unreleased', 'digital', 'upcoming'],
  },
  {
    id: 'filters.hideUnreleasedDigitalSearch', section: 'filters', anchor: 'hide-unreleased-digital-search',
    label: 'Hide Unreleased Movies in Search',
    description: "Hide movies that haven't been released digitally yet. Applies to movie catalogs only.",
    keywords: ['unreleased', 'digital', 'upcoming'],
  },
  {
    id: 'filters.hideUnreleasedShows', section: 'filters', anchor: 'hide-unreleased-shows',
    label: 'Hide Unreleased Shows in Catalogs',
    description: "Hide series that haven't aired yet based on their release date. Applies to series catalogs only.",
    keywords: ['unreleased', 'unaired', 'upcoming'],
  },
  {
    id: 'filters.hideUnreleasedShowsSearch', section: 'filters', anchor: 'hide-unreleased-shows-search',
    label: 'Hide Unreleased Shows in Search',
    description: "Hide series that haven't aired yet based on their release date. Applies to series catalogs only.",
    keywords: ['unreleased', 'unaired', 'upcoming'],
  },
  {
    id: 'filters.hideWatchedTrakt', section: 'filters', anchor: 'hide-watched-trakt',
    label: 'Hide Trakt Watched Items',
    description: "Hide items you've already watched on Trakt, AniList, MDBList or Simkl from all catalogs.",
    keywords: ['watched', 'seen', 'trakt'],
  },
  {
    id: 'filters.hideWatchedAnilist', section: 'filters', anchor: 'hide-watched-anilist',
    label: 'Hide AniList Watched Items',
    description: "Hide items you've already watched on Trakt, AniList, MDBList or Simkl from all catalogs.",
    keywords: ['watched', 'seen', 'anime'],
  },
  {
    id: 'filters.hideWatchedMdblist', section: 'filters', anchor: 'hide-watched-mdblist',
    label: 'Hide MDBList Watched Items',
    description: "Hide items you've already watched on Trakt, AniList, MDBList or Simkl from all catalogs.",
    keywords: ['watched', 'seen'],
  },
  {
    id: 'filters.hideWatchedSimkl', section: 'filters', anchor: 'hide-watched-simkl',
    label: 'Hide Simkl Watched Items',
    description: "Hide items you've already watched on Trakt, AniList, MDBList or Simkl from all catalogs.",
    keywords: ['watched', 'seen', 'anime', 'simkl'],
  },
  {
    id: 'filters.exclusionGenres', section: 'filters', anchor: 'exclusion-genres',
    label: 'Exclude Genres',
    description: 'Comma-separated genre names. Any item tagged with a matching genre will be hidden.',
    keywords: ['genre', 'exclude', 'block', 'hide'],
  },
  {
    id: 'filters.exclusionKeywords', section: 'filters', anchor: 'exclusion-keywords',
    label: 'Exclude Keywords',
    description: 'Comma-separated words matched against the title and description of each item.',
    keywords: ['exclude', 'block', 'hide', 'word'],
  },
  {
    id: 'filters.regexExclusion', section: 'filters', anchor: 'regex-exclusion-filter',
    label: 'Advanced Pattern (Regex)',
    description: 'Advanced users only. Matched against title and description. Use | to separate patterns.',
    keywords: ['regex', 'pattern', 'exclude', 'advanced'],
  },

  // ── Meta Providers — sections/ProvidersSettings.tsx ──
  {
    id: 'providers.trailerProvider', section: 'providers', anchor: 'trailerProvider',
    label: 'Trailer Source',
    description: 'Use the metadata provider\'s trailers, or any Stremio trailer addon.',
    keywords: ['trailer', 'streailer', 'language'],
  },
  {
    id: 'providers.movieProvider', section: 'providers', anchor: 'movie-provider',
    label: 'Movie Provider',
    description: 'Source for movie data.',
    keywords: ['tmdb', 'tvdb', 'imdb', 'metadata', 'movie'],
  },
  {
    id: 'providers.seriesProvider', section: 'providers', anchor: 'series-provider',
    label: 'Series Provider',
    description: 'Source for TV show data.',
    keywords: ['tvdb', 'tmdb', 'tvmaze', 'imdb', 'series', 'tv show'],
  },
  {
    id: 'providers.animeProvider', section: 'providers', anchor: 'anime-provider',
    label: 'Anime Provider',
    description: 'Source for anime data.',
    keywords: ['kitsu', 'mal', 'tvdb', 'imdb', 'anime'],
  },
  {
    id: 'providers.tvdbSeasonOrder', section: 'providers', anchor: 'tvdb-season-order',
    label: 'Season Order',
    description: '"Aired Order (Default)" or "Official order" are recommended.',
    keywords: ['tvdb', 'season', 'episode order'],
  },
  {
    id: 'providers.scrapeImdb', section: 'providers', anchor: 'scrape-imdb',
    label: 'Scrape IMDb Data',
    description: "Automatically scrape additional data from IMDb to obtain IMDb ID when missing from TMDB. This is useful for sports events and other content that doesn't have an IMDb ID in TMDB.",
    keywords: ['imdb', 'tmdb', 'scrape'],
  },
  {
    id: 'providers.forceLatinCast', section: 'providers', anchor: 'force-latin-cast',
    label: 'Force Latin TMDB Cast Names',
    description: 'Fetch English TMDB cast credits even when your display language is another locale (useful for Asian productions with non-Latin character sets).',
    keywords: ['cast', 'latin', 'tmdb', 'actors'],
  },
  {
    id: 'providers.forceAnimeForImdb', section: 'providers', anchor: 'force-anime-for-imdb',
    label: 'Anime Detection Override',
    description: 'When enabled, any catalog item that maps to an anime (via MAL/Kitsu/AniList/AniDB... detection) will use the Anime meta provider, even if the original catalog was non-anime.',
    keywords: ['anime', 'detection', 'imdb', 'override'],
  },
  {
    id: 'providers.malUseImdb', section: 'providers', anchor: 'mal-use-imdb',
    label: 'Use IMDb ID for Catalog/Search for Series',
    description: 'Prefer IMDb IDs for anime items in Anime catalogs and search (when available).',
    keywords: ['mal', 'imdb', 'anime'],
  },
  {
    id: 'providers.animeIdProvider', section: 'providers', anchor: 'anime-id-provider',
    label: 'Anime Stream Compatibility ID',
    description: 'Choose which ID format to use for anime. This affects which streaming addons will find results.',
    keywords: ['anime', 'id', 'kitsu', 'mal', 'imdb', 'compatibility'],
  },
  {
    id: 'providers.skipFiller', section: 'providers', anchor: 'skip-filler',
    label: 'Skip Filler Episodes',
    description: 'Automatically filter out episodes marked as filler.',
    keywords: ['mal', 'filler', 'anime', 'episode'],
  },
  {
    id: 'providers.skipRecap', section: 'providers', anchor: 'skip-recap',
    label: 'Skip Recap Episodes',
    description: 'Automatically filter out episodes marked as recaps.',
    keywords: ['mal', 'recap', 'anime', 'episode'],
  },
  {
    id: 'providers.allowEpisodeMarking', section: 'providers', anchor: 'allow-episode-marking',
    label: 'Allow Episode Marking',
    description: 'Enable users to mark episodes as filler or recap.',
    keywords: ['mal', 'filler', 'recap', 'mark'],
  },

  // ── Art Providers — sections/ArtProviderSettings.tsx ──
  // Nine matrix cells, anchors `art-${contentType}-${artType}` from CONTENT_TYPES × ART_TYPES.
  {
    id: 'artProviders.moviePoster', section: 'art-providers', anchor: 'art-movie-poster',
    label: 'Movies Poster',
    description: 'Pick a source for each combination of content type and artwork. "Meta Provider (default)" follows whatever you chose on the Meta Providers page.',
    keywords: ['poster', 'artwork', 'movie'],
  },
  {
    id: 'artProviders.movieBackground', section: 'art-providers', anchor: 'art-movie-background',
    label: 'Movies Background',
    description: 'Pick a source for each combination of content type and artwork. "Meta Provider (default)" follows whatever you chose on the Meta Providers page.',
    keywords: ['background', 'fanart', 'artwork', 'movie'],
  },
  {
    id: 'artProviders.movieLogo', section: 'art-providers', anchor: 'art-movie-logo',
    label: 'Movies Logo',
    description: 'Pick a source for each combination of content type and artwork. "Meta Provider (default)" follows whatever you chose on the Meta Providers page.',
    keywords: ['logo', 'artwork', 'movie'],
  },
  {
    id: 'artProviders.seriesPoster', section: 'art-providers', anchor: 'art-series-poster',
    label: 'Series Poster',
    description: 'Pick a source for each combination of content type and artwork. "Meta Provider (default)" follows whatever you chose on the Meta Providers page.',
    keywords: ['poster', 'artwork', 'series', 'tv'],
  },
  {
    id: 'artProviders.seriesBackground', section: 'art-providers', anchor: 'art-series-background',
    label: 'Series Background',
    description: 'Pick a source for each combination of content type and artwork. "Meta Provider (default)" follows whatever you chose on the Meta Providers page.',
    keywords: ['background', 'fanart', 'artwork', 'series', 'tv'],
  },
  {
    id: 'artProviders.seriesLogo', section: 'art-providers', anchor: 'art-series-logo',
    label: 'Series Logo',
    description: 'Pick a source for each combination of content type and artwork. "Meta Provider (default)" follows whatever you chose on the Meta Providers page.',
    keywords: ['logo', 'artwork', 'series', 'tv'],
  },
  {
    id: 'artProviders.animePoster', section: 'art-providers', anchor: 'art-anime-poster',
    label: 'Anime Poster',
    description: 'Pick a source for each combination of content type and artwork. "Meta Provider (default)" follows whatever you chose on the Meta Providers page.',
    keywords: ['poster', 'artwork', 'anime'],
  },
  {
    id: 'artProviders.animeBackground', section: 'art-providers', anchor: 'art-anime-background',
    label: 'Anime Background',
    description: 'Pick a source for each combination of content type and artwork. "Meta Provider (default)" follows whatever you chose on the Meta Providers page.',
    keywords: ['background', 'fanart', 'artwork', 'anime'],
  },
  {
    id: 'artProviders.animeLogo', section: 'art-providers', anchor: 'art-anime-logo',
    label: 'Anime Logo',
    description: 'Pick a source for each combination of content type and artwork. "Meta Provider (default)" follows whatever you chose on the Meta Providers page.',
    keywords: ['logo', 'artwork', 'anime'],
  },
  {
    id: 'artProviders.englishArtOnly', section: 'art-providers', anchor: 'english-art-only',
    label: 'English Art Only',
    description: 'Force all artwork to be in English language, regardless of your language setting.',
    keywords: ['english', 'language', 'artwork'],
  },
  {
    id: 'artProviders.originalLangFallback', section: 'art-providers', anchor: 'original-lang-fallback',
    label: 'Original Language Poster Fallback',
    description: "Skip region-mismatched posters in your display language and fall back to English or the title's original language instead.",
    keywords: ['poster', 'language', 'fallback'],
  },
  {
    id: 'artProviders.posterRatingProvider', section: 'art-providers', anchor: 'posterRatingProvider',
    label: 'Rating Poster Provider',
    description: 'Pre-fills poster patterns. Choose Custom for manual patterns.',
    keywords: ['rpdb', 'rating poster', 'top posters'],
  },
  {
    id: 'artProviders.usePosterProxy', section: 'art-providers', anchor: 'usePosterProxy',
    label: 'Proxy Rating & Custom Art',
    description: 'Route requests through addon with fallback to original art.',
    keywords: ['proxy', 'poster', 'rating'],
  },
  {
    id: 'artProviders.customPosterPattern', section: 'art-providers', anchor: 'custom-poster-pattern',
    label: 'Poster URL Pattern',
    description: 'Override art with custom URL patterns. If a placeholder references an unavailable value, normal art is used instead.',
    keywords: ['poster', 'custom url', 'override', 'pattern'],
  },
  {
    id: 'artProviders.customBackgroundPattern', section: 'art-providers', anchor: 'custom-background-pattern',
    label: 'Background URL Pattern',
    description: 'Override art with custom URL patterns. If a placeholder references an unavailable value, normal art is used instead.',
    keywords: ['background', 'custom url', 'override', 'pattern'],
  },
  {
    id: 'artProviders.customLandscapePattern', section: 'art-providers', anchor: 'custom-landscape-pattern',
    label: 'Landscape URL Pattern',
    description: 'Override art with custom URL patterns. If a placeholder references an unavailable value, normal art is used instead.',
    keywords: ['landscape', 'wide', 'custom url', 'override', 'pattern'],
  },
  {
    id: 'artProviders.customLogoPattern', section: 'art-providers', anchor: 'custom-logo-pattern',
    label: 'Logo URL Pattern',
    description: 'Override art with custom URL patterns. If a placeholder references an unavailable value, normal art is used instead.',
    keywords: ['logo', 'custom url', 'override', 'pattern'],
  },
  {
    id: 'artProviders.customThumbnailPattern', section: 'art-providers', anchor: 'custom-thumbnail-pattern',
    label: 'Episode Thumbnail URL Pattern',
    description: 'Override art with custom URL patterns. If a placeholder references an unavailable value, normal art is used instead.',
    keywords: ['thumbnail', 'episode', 'custom url', 'override', 'pattern'],
  },

  // ── Search — sections/SearchSettings.tsx ──
  // Eight engine rows, anchors `search-engine-${slot.id}` from SEARCH_SLOTS.
  {
    id: 'search.engineMovie', section: 'search', anchor: 'search-engine-movie',
    label: 'Movies Search',
    description: 'Choose the engine for each search catalog, enable or disable it, and drag to reorder how they appear in Stremio. Disabled catalogs are listed last.',
    keywords: ['movie', 'engine', 'provider'],
  },
  {
    id: 'search.engineSeries', section: 'search', anchor: 'search-engine-series',
    label: 'Series Search',
    description: 'Choose the engine for each search catalog, enable or disable it, and drag to reorder how they appear in Stremio. Disabled catalogs are listed last.',
    keywords: ['series', 'engine', 'provider'],
  },
  {
    id: 'search.engineTvdbCollections', section: 'search', anchor: 'search-engine-tvdb.collections.search',
    label: 'TVDB Collections',
    description: 'Choose the engine for each search catalog, enable or disable it, and drag to reorder how they appear in Stremio. Disabled catalogs are listed last.',
    keywords: ['tvdb', 'collections'],
  },
  {
    id: 'search.engineAiSearch', section: 'search', anchor: 'search-engine-gemini.search',
    label: 'AI Search',
    description: 'Choose the engine for each search catalog, enable or disable it, and drag to reorder how they appear in Stremio. Disabled catalogs are listed last.',
    keywords: ['ai', 'gemini', 'search'],
  },
  {
    id: 'search.engineAnimeSeries', section: 'search', anchor: 'search-engine-anime_series',
    label: 'Anime Series Search',
    description: 'Choose the engine for each search catalog, enable or disable it, and drag to reorder how they appear in Stremio. Disabled catalogs are listed last.',
    keywords: ['anime', 'series'],
  },
  {
    id: 'search.engineAnimeMovie', section: 'search', anchor: 'search-engine-anime_movie',
    label: 'Anime Movies Search',
    description: 'Choose the engine for each search catalog, enable or disable it, and drag to reorder how they appear in Stremio. Disabled catalogs are listed last.',
    keywords: ['anime', 'movie'],
  },
  {
    id: 'search.enginePeopleMovie', section: 'search', anchor: 'search-engine-people_search_movie',
    label: 'People Search (Movies)',
    description: 'Choose the engine for each search catalog, enable or disable it, and drag to reorder how they appear in Stremio. Disabled catalogs are listed last.',
    keywords: ['people', 'actor', 'cast', 'movie'],
  },
  {
    id: 'search.enginePeopleSeries', section: 'search', anchor: 'search-engine-people_search_series',
    label: 'People Search (Series)',
    description: 'Choose the engine for each search catalog, enable or disable it, and drag to reorder how they appear in Stremio. Disabled catalogs are listed last.',
    keywords: ['people', 'actor', 'cast', 'series'],
  },
  {
    id: 'search.searchEnabled', section: 'search', anchor: 'search-enabled',
    label: 'Enable Search functionality',
    description: "Configure your addon's search functionality.",
    keywords: ['search', 'enable', 'disable'],
  },
  {
    id: 'search.aiSearchEnabled', section: 'search', anchor: 'ai-search-enabled',
    label: 'Enable AI Search',
    description: 'A Gemini or OpenRouter API key is required to enable AI search. Add your key in the Integrations settings.',
    keywords: ['ai', 'gemini', 'openrouter', 'search'],
  },
  {
    id: 'search.aiProvider', section: 'search', anchor: 'ai-provider',
    label: 'Provider',
    description: 'Choose your AI provider',
    keywords: ['ai', 'gemini', 'openrouter', 'provider'],
  },
  {
    id: 'search.aiModel', section: 'search', anchor: 'ai-model',
    label: 'Model',
    description: 'Any OpenRouter model ID',
    keywords: ['ai', 'model', 'gemini', 'openrouter'],
  },
  {
    id: 'search.aiTriggerKeyword', section: 'search', anchor: 'ai-trigger-keyword',
    label: 'Trigger Keyword',
    description: 'Only run AI search when the query starts with this word. Leave blank to run it on every query. Your other search results are never affected.',
    keywords: ['ai', 'keyword', 'trigger'],
  },
  {
    id: 'search.aiWebSearch', section: 'search', anchor: 'ai-web-search',
    label: 'Web Search',
    description: 'Requires a paid Gemini API key. Free keys will get 429 errors.',
    keywords: ['ai', 'web search', 'gemini'],
  },

  // ── Configuration — ConfigurationManager.tsx ──
  {
    id: 'configuration.catalogModeOnly', section: 'configuration', anchor: 'catalog-mode-only',
    label: 'Catalog Mode Only',
    description: 'Catalogs only, no Meta. Use when another addon supplies it: a second AIOMetadata instance, or a different meta provider.',
    keywords: ['catalog mode', 'manifest', 'metadata', 'meta', 'resources'],
  },
  {
    id: 'configuration.hideStremioCatalogs', section: 'configuration', anchor: 'hide-stremio-catalogs',
    label: 'Hide Stremio-Specific Catalogs',
    description: 'Leaves catalogs only Stremio uses, such as Calendar videos, out of the manifest. Clients that do not use them can flicker while they render them and then drop them.',
    keywords: ['stremio', 'catalog', 'manifest', 'metadata', 'calendar', 'calendar videos', 'nuvio', 'flicker'],
  },
  {
    id: 'configuration.password', section: 'configuration', anchor: 'cfgmgr-password',
    label: 'Password',
    description: 'Password must be at least 6 characters long.',
    keywords: ['password', 'create password', 'protect'],
  },
  {
    id: 'configuration.confirmPassword', section: 'configuration', anchor: 'cfgmgr-confirm-password',
    label: 'Confirm Password',
    description: 'Must match the password above and be at least 6 characters.',
    keywords: ['password', 'confirm'],
  },
  {
    id: 'configuration.addonPassword', section: 'configuration', anchor: 'cfgmgr-addon-password',
    label: 'Addon Password',
    description: 'Required by the addon administrator.',
    keywords: ['addon password', 'password'],
  },

  // ── Catalogs — coarse, anchor: null (spec §4.3) ──
  // CatalogsSettings.tsx is 5,512 lines and imports six integration panels
  // (:3-12). Entries named after what people look for.
  {
    id: 'catalogs.root', section: 'catalogs', anchor: null,
    label: 'Catalog Management',
    description: 'Add, remove, reorder and rename the catalogs your addon exposes.',
    keywords: ['catalog', 'list', 'order', 'enable', 'rename'],
  },
  {
    id: 'catalogs.trakt', section: 'catalogs', anchor: null,
    label: 'Trakt Catalogs',
    description: 'Watchlists, collections, recommendations and calendars from Trakt.',
    keywords: ['trakt', 'watchlist', 'collection', 'calendar'],
  },
  {
    id: 'catalogs.mdblist', section: 'catalogs', anchor: null,
    label: 'MDBList Catalogs',
    description: 'Import your public and private lists from MDBList.com to use as catalogs.',
    keywords: ['mdblist', 'list', 'catalog'],
  },
  {
    id: 'catalogs.simkl', section: 'catalogs', anchor: null,
    label: 'Simkl Catalogs',
    description: 'Add watchlist catalogs for movies, shows, and anime by status',
    keywords: ['simkl', 'watchlist', 'anime', 'trending'],
  },
  {
    id: 'catalogs.letterboxd', section: 'catalogs', anchor: null,
    label: 'Letterboxd Catalogs',
    description: 'Import your Letterboxd lists and watchlists as catalogs via StremThru',
    keywords: ['letterboxd', 'list', 'watchlist'],
  },
  {
    id: 'catalogs.tvdbLists', section: 'catalogs', anchor: null,
    label: 'TheTVDB Lists',
    description: 'Add a TheTVDB list as its own catalog, by slug or by picking one from the site',
    keywords: ['tvdb', 'thetvdb', 'list', 'slug', 'collection'],
  },
  // Composed, not verbatim: this is a coarse section-level entry with no single
  // control behind it, so there is no one sentence in the UI to quote.
  {
    id: 'catalogs.anilist', section: 'catalogs', anchor: null,
    label: 'AniList Catalogs',
    description: 'Watchlists, trending anime, and imported user lists from AniList.',
    keywords: ['anilist', 'anime', 'watchlist', 'trending'],
  },
  {
    id: 'catalogs.tmdbDiscover', section: 'catalogs', anchor: null,
    label: 'TMDB Discover',
    description: 'Create custom TMDB, TVDB, Simkl, or AniList discover catalogs with filters and save them directly into your catalog list.',
    keywords: ['discover', 'tmdb', 'filter', 'custom catalog'],
  },

  // ── Setup — coarse, anchor: null ──
  {
    id: 'presets.startingLineup', section: 'presets', anchor: null,
    label: 'Starting lineup',
    description: 'Say what you watch and pick how many built-in catalogs to turn on, then preview the result before applying it.',
    keywords: ['setup', 'preset', 'template', 'lineup', 'quick setup', 'starter', 'wizard'],
  },
  {
    id: 'presets.anime', section: 'presets', anchor: null,
    label: 'Anime handling',
    description: 'Choose whether anime is included and which source supplies its metadata and artwork.',
    keywords: ['anime', 'kitsu', 'mal', 'tvdb', 'grouped seasons'],
  },
  {
    id: 'presets.curators', section: 'presets', anchor: null,
    label: 'Curator lineups',
    description: 'Browse curated MDBList collections and import the lists you want. Needs your own MDBList key.',
    keywords: ['curator', 'mdblist', 'lists', 'curated', 'import'],
  },
  {
    id: 'presets.backup', section: 'presets', anchor: null,
    label: 'Configuration backup',
    description: 'Download your full configuration, including API keys, before applying a setup that replaces your catalogs.',
    keywords: ['backup', 'export', 'import', 'share', 'config'],
  },
];
