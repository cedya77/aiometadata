import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useConfig } from '@/contexts/ConfigContext';
import { Switch } from '@/components/ui/switch';

const movieProviders = [
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'tvdb', label: 'TheTVDB' },
  { value: 'imdb', label: 'IMDb' },
];

const seriesProviders = [
  { value: 'tvdb', label: 'TheTVDB (Recommended)' },
  { value: 'tmdb', label: 'The Movie Database' },
  { value: 'tvmaze', label: 'TVmaze' },
  { value: 'imdb', label: 'IMDb' },
];

const animeProviders = [
  { value: 'kitsu', label: 'Kitsu (Recommended)' },
  { value: 'mal', label: 'MyAnimeList' },
  { value: 'tvdb', label: 'TheTVDB' },
  // { value: 'tmdb', label: 'The Movie Database' },
  { value: 'imdb', label: 'IMDb' },
];

const animeIdProviders = [
  { value: 'imdb', label: 'IMDb (More compatibility)' },
  { value: 'kitsu', label: 'Kitsu ID (Recommended)' },
  { value: 'mal', label: 'MyAnimeList ID' },
  { value: 'retain', label: 'Retain Requested ID (Auto-detect)' },
];

const tvdbSeasonTypes = [
  { value: 'official', label: 'Official Order' },
  { value: 'default', label: 'Aired Order (Default)' },
  { value: 'dvd', label: 'DVD Order' },
  { value: 'absolute', label: 'Absolute Order' },
  { value: 'alternate', label: 'Alternate Order' },
  { value: 'regional', label: 'Regional Order' },
];


export function ProvidersSettings() {
  const { config, setConfig, hasBuiltInTvdb } = useConfig();
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
        <h2 className="text-2xl font-semibold">Metadata Providers</h2>
        <p className="text-muted-foreground mt-1">Choose your preferred source for metadata. Different providers may have better data for certain content.</p>
        <p className="text-xs text-amber-400 mt-4 p-3 bg-amber-900/20 border border-amber-400/30 rounded-lg">
          <strong>Smart Fallback:</strong> If metadata for a title can't be found with your preferred provider (e.g., no TVDB entry for a TMDB movie), the addon will automatically use the item's original source to guarantee you get a result.
        </p>
      </div>

      {/* Provider Selection Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Card>
          <CardHeader><CardTitle>Movie Provider</CardTitle><CardDescription>Source for movie data.</CardDescription></CardHeader>
          <CardContent>
            <Select value={config.providers.movie} onValueChange={(val) => handleProviderChange('movie', val)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {movieProviders.map(p => (
                  <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                    {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Series Provider</CardTitle><CardDescription>Source for TV show data.</CardDescription></CardHeader>
          <CardContent>
            <Select value={config.providers.series} onValueChange={(val) => handleProviderChange('series', val)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {seriesProviders.map(p => (
                  <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                    {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Anime Provider</CardTitle><CardDescription>Source for anime data.</CardDescription></CardHeader>
          <CardContent>
            <Select value={config.providers.anime} onValueChange={(val) => handleProviderChange('anime', val)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(isImdbForCatalog ? animeProviders.filter(p => p.value !== 'mal' && p.value !== 'kitsu') : animeProviders)
                  .map(p => (
                    <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                      {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {isImdbForCatalog && (
              <p className="text-xs text-muted-foreground mt-2">MAL is disabled because "Use IMDb ID for Catalog/Search" is enabled in MAL settings.</p>
            )}
          </CardContent>
        </Card>
      </div>



      {/* TVDB Specific Settings */}
      <Card className={!hasTvdbKey ? 'opacity-50' : ''}>
        <CardHeader>
          <CardTitle>TheTVDB Settings</CardTitle>
          <CardDescription>
            {hasTvdbKey 
              ? 'Customize how episode data is fetched from TheTVDB.'
              : 'Add your TVDB API key in the Integrations tab to enable these settings.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="max-w-md">
            <Label className="text-lg font-medium">Season Order</Label>
            <Select value={config.tvdbSeasonType} onValueChange={handleSeasonTypeChange} disabled={!hasTvdbKey}>
              <SelectTrigger className="mt-2"><SelectValue /></SelectTrigger>
              <SelectContent>
                {tvdbSeasonTypes.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-2">"Aired Order (Default)" or "Official order" are recommended.</p>
        </CardContent>
      </Card>

      {/* TMDB Specific Settings */}
      <Card>
        <CardHeader>
          <CardTitle>The Movie Database (TMDB) Settings</CardTitle>
          <CardDescription>Customize how data is handled when TMDB is the source.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Scrape IMDb Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="scrape-imdb" className="text-lg font-medium">Scrape IMDb Data</Label>
              <p className="text-sm text-muted-foreground">Automatically scrape additional data from IMDb to obtain IMDb ID when missing from TMDB. This is useful for sports events and other content that doesn't have an IMDb ID in TMDB.</p>
            </div>
            <Switch
              id="scrape-imdb"
              checked={config.tmdb?.scrapeImdb || false}
              onCheckedChange={(val) => handleTmdbToggle('scrapeImdb', val)}
            />
          </div>
          {/* Force Latin Cast Names */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="force-latin-cast" className="text-lg font-medium">Force Latin TMDB Cast Names</Label>
              <p className="text-sm text-muted-foreground">
                Fetch English TMDB cast credits even when your display language is another locale (useful for Asian productions with non-Latin character sets).
              </p>
            </div>
            <Switch
              id="force-latin-cast"
              checked={!!config.tmdb?.forceLatinCastNames}
              onCheckedChange={(val) => handleTmdbToggle('forceLatinCastNames', val)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Anime Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Anime Settings</CardTitle>
          <CardDescription>
            Configure how anime content is detected and handled across catalogs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Anime Detection Override */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="force-anime-for-imdb" className="text-lg font-medium">Anime Detection Override</Label>
              <p className="text-sm text-muted-foreground">When enabled, any catalog item that maps to an anime (via MAL/Kitsu/AniList/AniDB... detection) will use the Anime meta provider, even if the original catalog was non-anime.</p>
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                ⚠️ Note: Detected anime with IMDb IDs will use Movie/Series art providers instead of Anime art providers.
              </p>
            </div>
            <Switch
              id="force-anime-for-imdb"
              checked={config.providers.forceAnimeForDetectedImdb || false}
              onCheckedChange={handleForceAnimeToggle}
            />
          </div>

          {/* Use IMDb ID for Catalog/Search */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="mal-use-imdb" className="text-lg font-medium">Use IMDb ID for Catalog/Search for Series</Label>
              <p className="text-sm text-muted-foreground">Prefer IMDb IDs for anime items in Anime catalogs and search (when available).</p>
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                ⚠️ Note: Anime in catalogs/search will use Movie/Series art providers instead of Anime art providers when this is enabled.
              </p>
            </div>
            <Switch
              id="mal-use-imdb"
              checked={!!config.mal.useImdbIdForCatalogAndSearch}
              onCheckedChange={handleMalUseImdbToggle}
            />
          </div>

          {/* Anime Stream Compatibility ID */}
          <div className="pt-6 border-t border-border">
            <Label className="text-lg font-medium">Anime Stream Compatibility ID</Label>
            <p className="text-sm text-muted-foreground mt-1 mb-2">
              Choose which ID format to use for anime. This affects which streaming addons will find results.
            </p>
            <Select 
              value={config.providers.anime_id_provider}
              onValueChange={handleAnimeIdProviderChange as (value: string) => void}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {animeIdProviders.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-2">
              "IMDb" can improve compatibility as it is supported by most streaming addons. "Retain Requested ID" automatically uses the ID type from the request (e.g., IMDb for tt123, Kitsu for kitsu:456, MAL for mal:789). Kitsu is recommended when using MAL as meta provider.
            </p>
            <p className="text-xs text-amber-600 mt-1">
              ⚠️ Using TVDB/IMDb as anime meta provider with Kitsu/MAL anime compatibility ID is considered experimental as they rely on community mappings and could contain inaccurate information.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* MyAnimeList Specific Settings */}
      <Card>
        <CardHeader>
          <CardTitle>MyAnimeList (MAL) Settings</CardTitle>
          <CardDescription>
            Customize how data is handled when MyAnimeList is the source.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Skip Filler Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="skip-filler" className="text-lg font-medium">Skip Filler Episodes</Label>
              <p className="text-sm text-muted-foreground">Automatically filter out episodes marked as filler.</p>
            </div>
            <Switch
              id="skip-filler"
              checked={config.mal.skipFiller}
              onCheckedChange={(val) => handleMalToggle('skipFiller', val)}
            />
          </div>
          {/* Skip Recap Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="skip-recap" className="text-lg font-medium">Skip Recap Episodes</Label>
              <p className="text-sm text-muted-foreground">Automatically filter out episodes marked as recaps.</p>
            </div>
            <Switch
              id="skip-recap"
              checked={config.mal.skipRecap}
              onCheckedChange={(val) => handleMalToggle('skipRecap', val)}
            />
          </div>
          {/* Allow Episode Marking Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="allow-episode-marking" className="text-lg font-medium">Allow Episode Marking</Label>
              <p className="text-sm text-muted-foreground">Enable users to mark episodes as filler or recap.</p>
            </div>
            <Switch
              id="allow-episode-marking"
              checked={config.mal.allowEpisodeMarking}
              onCheckedChange={(val) => handleMalToggle('allowEpisodeMarking', val)}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
