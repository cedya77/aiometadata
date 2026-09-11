import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { useConfig } from '@/contexts/ConfigContext';
import { isInUse } from '@/lib/metaProviderUsage';
import { Callout } from '@/components/settings/Callout';
import { CollapsibleSettingCard } from '@/components/settings/CollapsibleSettingCard';
import { ProviderSelect, type SelectableOption } from '@/components/settings/ProviderSelect';
import { SettingRow } from '@/components/settings/SettingRow';
import { NoticeDisclosure } from '@/components/settings/NoticeDisclosure';
import { animeNotices } from '@/lib/animeNotices';

const STREAILER_CONFIGURE = 'https://streailer.elfhosted.com/configure';

const trailerProviders: SelectableOption[] = [
  { value: 'default', label: 'Metadata provider (default)' },
  { value: 'streailer', label: 'Streailer' },
  { value: 'custom', label: 'Custom addon' },
];

const movieProviders: SelectableOption[] = [
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'tvdb', label: 'TheTVDB', requiresKey: 'tvdb' },
  { value: 'imdb', label: 'IMDb (Cinemeta)' },
];

const seriesProviders: SelectableOption[] = [
  { value: 'tvdb', label: 'TheTVDB (Recommended)', requiresKey: 'tvdb' },
  { value: 'tmdb', label: 'The Movie Database' },
  { value: 'tvmaze', label: 'TVmaze' },
  { value: 'imdb', label: 'IMDb (Cinemeta)' },
];

const animeProviders: SelectableOption[] = [
  { value: 'kitsu', label: 'Kitsu (Recommended)' },
  { value: 'mal', label: 'MyAnimeList' },
  { value: 'tvdb', label: 'TheTVDB', requiresKey: 'tvdb' },
  // { value: 'tmdb', label: 'The Movie Database' },
  { value: 'imdb', label: 'IMDb (Cinemeta)' },
];

const animeIdProviders: SelectableOption[] = [
  { value: 'imdb', label: 'IMDb (More compatibility)' },
  { value: 'kitsu', label: 'Kitsu ID (Recommended)' },
  { value: 'mal', label: 'MyAnimeList ID' },
  { value: 'retain', label: 'Retain Requested ID (Auto-detect)' },
];

const tvdbSeasonTypes: SelectableOption[] = [
  { value: 'official', label: 'Official Order' },
  { value: 'default', label: 'Aired Order (Default)' },
  { value: 'dvd', label: 'DVD Order' },
  { value: 'absolute', label: 'Absolute Order' },
  { value: 'alternate', label: 'Alternate Order' },
  { value: 'regional', label: 'Regional Order' },
];

export function ProvidersSettings() {
  const { config, setConfig, hasBuiltInTvdb } = useConfig();
  // A config saved before this field existed has no trailerProvider. Derive it
  // once so the select and the fields below cannot disagree about what is set.
  const trailerProvider = config.trailerProvider || 'default';
  const isImdbForCatalog = !!config.mal?.useImdbIdForCatalogAndSearch;
  const hasTvdbKey = !!config.apiKeys?.tvdb?.trim() || hasBuiltInTvdb;

  const handleProviderChange = (type: 'movie' | 'series' | 'anime', value: string) => {
    setConfig(prev => ({ ...prev, providers: { ...prev.providers, [type]: value } }));
  };

  const handleSeasonTypeChange = (value: string) => {
    setConfig(prev => ({ ...prev, tvdbSeasonType: value }));
  };

  const handleMalToggle = (key: 'skipFiller' | 'skipRecap' | 'allowEpisodeMarking', checked: boolean) => {
    setConfig(prev => ({
      ...prev,
      mal: {
        ...prev.mal,
        [key]: checked,
      }
    }));
  };

  const handleMalUseImdbToggle = (checked: boolean) => {
    setConfig(prev => ({
      ...prev,
      mal: {
        ...prev.mal,
        useImdbIdForCatalogAndSearch: checked,
      },
      providers: {
        ...prev.providers,
        // If enabling, ensure MAL isn't selected as anime meta provider
        anime: checked && (prev.providers.anime === 'mal' || prev.providers.anime === 'kitsu') ? 'imdb' : prev.providers.anime,
        // No automatic switching of anime_id_provider
      }
    }));
  };

  const handleAnimeIdProviderChange = (value: 'imdb' | 'kitsu' | 'mal') => {
    setConfig(prev => ({
      ...prev,
      providers: {
        ...prev.providers,
        anime_id_provider: value
      }
    }));
  };

  const handleTmdbToggle = (key: 'scrapeImdb' | 'forceLatinCastNames', checked: boolean) => {
    setConfig(prev => ({
      ...prev,
      tmdb: {
        ...prev.tmdb,
        [key]: checked,
      }
    }));
  };

  const handleForceAnimeToggle = (checked: boolean) => {
    setConfig(prev => ({
      ...prev,
      providers: {
        ...prev.providers,
        forceAnimeForDetectedImdb: checked
      }
    }));
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Meta Providers</h2>
        <p className="text-muted-foreground mt-1">
          Choose your preferred source for metadata. Different providers may have better data for certain content.
        </p>
        {/* info, not warn: this is reassurance, and amber for good news devalues
            amber for the real warning two cards below. */}
        <Callout variant="info" className="mt-4">
          <strong>Smart Fallback:</strong> If metadata for a title can't be found with your preferred provider (e.g., no TVDB entry for a TMDB movie), the addon will automatically use the item's original source to guarantee you get a result.
        </Callout>
      </div>

      {/* Provider Selection Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Card className="mb-6">
          <CardContent className="pt-6">
            <SettingRow
              htmlFor="trailerProvider"
              label="Trailer Source"
              description="Use the metadata provider's trailers, or any Stremio trailer addon."
              control={
                <ProviderSelect
                  id="trailerProvider"
                  ariaLabel="Trailer source"
                  value={trailerProvider}
                  onValueChange={(value) => {
                    const provider = value as 'default' | 'streailer' | 'custom';
                    if (provider === 'streailer') {
                      // Deliberately not prefilled. The bare manifest URL returns
                      // the addon's own default language, so filling it in hands
                      // the user a working-looking setting they did not choose.
                      setConfig(prev => ({ ...prev, trailerProvider: provider, trailerAddonUrl: '' }));
                    } else if (provider === 'default') {
                      setConfig(prev => ({ ...prev, trailerProvider: provider, trailerAddonUrl: '' }));
                    } else {
                      setConfig(prev => ({ ...prev, trailerProvider: provider }));
                    }
                  }}
                  options={trailerProviders}
                  className="w-full sm:w-[240px]"
                />
              }
            />
            {trailerProvider !== 'default' && (
              <SettingRow
                htmlFor="trailerAddonUrl"
                label="Trailer Addon URL"
                description="The addon's manifest URL. An unconfigured URL returns the addon's own default language, so set the language on its configure page and paste the URL it gives you."
                control={
                  <Input
                    id="trailerAddonUrl"
                    value={config.trailerAddonUrl || ''}
                    placeholder={STREAILER_CONFIGURE}
                    onChange={(e) => setConfig(prev => ({ ...prev, trailerAddonUrl: e.target.value }))}
                    className="w-full sm:w-[420px]"
                  />
                }
              />
            )}
            {trailerProvider === 'streailer' && (
              <p className="text-sm text-muted-foreground mt-2">
                Pick your language on{' '}
                <a href={STREAILER_CONFIGURE} target="_blank" rel="noreferrer" className="underline">
                  Streailer's configure page
                </a>
                , then paste the URL it produces above.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Movie Provider</CardTitle><CardDescription>Source for movie data.</CardDescription></CardHeader>
          <CardContent>
            <ProviderSelect
              id="movie-provider"
              ariaLabel="Movie metadata provider"
              value={config.providers.movie}
              onValueChange={(val) => handleProviderChange('movie', val)}
              options={movieProviders}
              hasTvdbKey={hasTvdbKey}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Series Provider</CardTitle><CardDescription>Source for TV show data.</CardDescription></CardHeader>
          <CardContent>
            <ProviderSelect
              id="series-provider"
              ariaLabel="Series metadata provider"
              value={config.providers.series}
              onValueChange={(val) => handleProviderChange('series', val)}
              options={seriesProviders}
              hasTvdbKey={hasTvdbKey}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Anime Provider</CardTitle><CardDescription>Source for anime data.</CardDescription></CardHeader>
          <CardContent>
            <ProviderSelect
              id="anime-provider"
              ariaLabel="Anime metadata provider"
              value={config.providers.anime}
              onValueChange={(val) => handleProviderChange('anime', val)}
              options={isImdbForCatalog
                ? animeProviders.filter(p => p.value !== 'mal' && p.value !== 'kitsu')
                : animeProviders}
              hasTvdbKey={hasTvdbKey}
            />
            {isImdbForCatalog && (
              <p className="text-xs text-muted-foreground mt-2">
                MAL is disabled because "Use IMDb ID for Catalog/Search" is enabled in MAL settings.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* TVDB Specific Settings */}
      <CollapsibleSettingCard
        title="TheTVDB Settings"
        anchorIds={['tvdb-season-order']}
        inUse={isInUse(config, 'tvdb')}
        description={hasTvdbKey
          ? 'Customize how episode data is fetched from TheTVDB.'
          : 'Add your TVDB API key in the Integrations tab to enable these settings.'}
      >
        <SettingRow
          htmlFor="tvdb-season-order"
          label="Season Order"
          description='"Aired Order (Default)" or "Official order" are recommended.'
          control={
            <ProviderSelect
              id="tvdb-season-order"
              ariaLabel="TheTVDB season order"
              value={config.tvdbSeasonType}
              onValueChange={handleSeasonTypeChange}
              options={tvdbSeasonTypes}
              hasTvdbKey={hasTvdbKey}
              disabled={!hasTvdbKey}
              className="w-full sm:w-[240px]"
            />
          }
        />
      </CollapsibleSettingCard>

      {/* TMDB Specific Settings */}
      <CollapsibleSettingCard
        title="The Movie Database (TMDB) Settings"
        anchorIds={['scrape-imdb', 'force-latin-cast']}
        inUse={isInUse(config, 'tmdb')}
        description="Customize how data is handled when TMDB is the source."
      >
        <SettingRow
          htmlFor="scrape-imdb"
          label="Scrape IMDb Data"
          description="Automatically scrape additional data from IMDb to obtain IMDb ID when missing from TMDB. This is useful for sports events and other content that doesn't have an IMDb ID in TMDB."
          control={
            <Switch
              id="scrape-imdb"
              checked={config.tmdb?.scrapeImdb || false}
              onCheckedChange={(val) => handleTmdbToggle('scrapeImdb', val)}
            />
          }
        />
        <SettingRow
          htmlFor="force-latin-cast"
          label="Force Latin TMDB Cast Names"
          description="Fetch English TMDB cast credits even when your display language is another locale (useful for Asian productions with non-Latin character sets)."
          control={
            <Switch
              id="force-latin-cast"
              checked={!!config.tmdb?.forceLatinCastNames}
              onCheckedChange={(val) => handleTmdbToggle('forceLatinCastNames', val)}
            />
          }
        />
      </CollapsibleSettingCard>

      {/* Anime Settings — always relevant: it concerns detection, not a selected provider */}
      <Card>
        <CardHeader>
          <CardTitle>Anime Settings</CardTitle>
          <CardDescription>
            Configure how anime content is detected and handled across catalogs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow
            htmlFor="force-anime-for-imdb"
            label="Anime Detection Override"
            description="When enabled, any catalog item that maps to an anime (via MAL/Kitsu/AniList/AniDB... detection) will use the Anime meta provider, even if the original catalog was non-anime."
            control={
              <Switch
                id="force-anime-for-imdb"
                checked={config.providers.forceAnimeForDetectedImdb || false}
                onCheckedChange={handleForceAnimeToggle}
              />
            }
          />
          <SettingRow
            htmlFor="mal-use-imdb"
            label="Use IMDb ID for Catalog/Search for Series"
            description="Prefer IMDb IDs for anime items in Anime catalogs and search (when available)."
            control={
              <Switch
                id="mal-use-imdb"
                checked={!!config.mal.useImdbIdForCatalogAndSearch}
                onCheckedChange={handleMalUseImdbToggle}
              />
            }
          />
          <SettingRow
            htmlFor="anime-id-provider"
            label="Anime Stream Compatibility ID"
            description="Choose which ID format to use for anime. This affects which streaming addons will find results."
            control={
              <ProviderSelect
                id="anime-id-provider"
                ariaLabel="Anime stream compatibility ID"
                value={config.providers.anime_id_provider}
                onValueChange={handleAnimeIdProviderChange as (value: string) => void}
                options={animeIdProviders}
                hasTvdbKey={hasTvdbKey}
                className="w-full sm:w-[280px]"
              />
            }
            note={
              /* Help text, not a notice: what "Retain Requested ID" does is not
                 guessable from the label, so it stays visible. */
              <p className="text-xs text-muted-foreground">
                "IMDb" can improve compatibility as it is supported by most streaming addons. "Retain Requested ID" automatically uses the ID type from the request (e.g., IMDb for tt123, Kitsu for kitsu:456, MAL for mal:789). Kitsu is recommended when using MAL as meta provider.
              </p>
            }
          />
          {/*
            Bottom, not top: these notices describe the rows above them, and a
            summary that precedes what it summarises reads as an error banner.
            Renders nothing when no notice applies — which on the shipped
            defaults is always — so the card gains no empty container and no
            stray separator.
          */}
          <NoticeDisclosure
            notices={animeNotices(config)}
            className="border-t border-white/[0.06] pt-3 mt-2"
          />
        </CardContent>
      </Card>

      {/* MyAnimeList Specific Settings */}
      <CollapsibleSettingCard
        title="MyAnimeList (MAL) Settings"
        anchorIds={['skip-filler', 'skip-recap', 'allow-episode-marking']}
        inUse={isInUse(config, 'mal')}
        description="Customize how data is handled when MyAnimeList is the source."
      >
        <SettingRow
          htmlFor="skip-filler"
          label="Skip Filler Episodes"
          description="Automatically filter out episodes marked as filler."
          control={
            <Switch
              id="skip-filler"
              checked={config.mal.skipFiller}
              onCheckedChange={(val) => handleMalToggle('skipFiller', val)}
            />
          }
        />
        <SettingRow
          htmlFor="skip-recap"
          label="Skip Recap Episodes"
          description="Automatically filter out episodes marked as recaps."
          control={
            <Switch
              id="skip-recap"
              checked={config.mal.skipRecap}
              onCheckedChange={(val) => handleMalToggle('skipRecap', val)}
            />
          }
        />
        <SettingRow
          htmlFor="allow-episode-marking"
          label="Allow Episode Marking"
          description="Enable users to mark episodes as filler or recap."
          control={
            <Switch
              id="allow-episode-marking"
              checked={config.mal.allowEpisodeMarking}
              onCheckedChange={(val) => handleMalToggle('allowEpisodeMarking', val)}
            />
          }
        />
      </CollapsibleSettingCard>
    </div>
  );
}
