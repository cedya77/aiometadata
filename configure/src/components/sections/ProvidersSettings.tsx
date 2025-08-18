import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useConfig } from '@/contexts/ConfigContext';
import { Switch } from '@/components/ui/switch';
import { AlertCircle } from 'lucide-react';

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
  { value: 'mal', label: 'MyAnimeList (Recommended)' },
  { value: 'tvdb', label: 'TheTVDB' },
  { value: 'tmdb', label: 'The Movie Database' },
  { value: 'imdb', label: 'IMDb' },
];

const animeIdProviders = [
  { value: 'imdb', label: 'IMDb (More compatibility)' },
  { value: 'kitsu', label: 'Kitsu ID (Recommended)' },
  { value: 'mal', label: 'MyAnimeList ID' },
];

const tvdbSeasonTypes = [
  { value: 'official', label: 'Official Order' },
  { value: 'default', label: 'Aired Order (Default)' },
  { value: 'dvd', label: 'DVD Order' },
  { value: 'absolute', label: 'Absolute Order' },
  { value: 'alternate', label: 'Alternate Order' },
  { value: 'regional', label: 'Regional Order' },
];

// Art provider options
const movieArtProviders = [
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'tvdb', label: 'TheTVDB' },
  { value: 'fanart', label: 'Fanart.tv' },
];

const seriesArtProviders = [
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'tvdb', label: 'TheTVDB' },
  { value: 'fanart', label: 'Fanart.tv' },
];

const animeArtProviders = [
  { value: 'mal', label: 'MyAnimeList' },
  { value: 'anilist', label: 'AniList' },
  { value: 'tvdb', label: 'TheTVDB' },
  { value: 'fanart', label: 'Fanart.tv' },
];


export function ProvidersSettings() {
  const { config, setConfig } = useConfig();

  const handleProviderChange = (type: 'movie' | 'series' | 'anime', value: string) => {
    setConfig(prev => ({ ...prev, providers: { ...prev.providers, [type]: value } }));
  };

  const handleSeasonTypeChange = (value: string) => {
    setConfig(prev => ({ ...prev, tvdbSeasonType: value }));
  };
 
  const handleMalToggle = (key: 'skipFiller' | 'skipRecap', checked: boolean) => {
    setConfig(prev => ({
      ...prev,
      mal: {
        ...prev.mal,
        [key]: checked,
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

  const handleArtProviderChange = (type: 'movie' | 'series' | 'anime', value: string) => {
    setConfig(prev => ({ 
      ...prev, 
      artProviders: { 
        ...prev.artProviders, 
        [type]: value as any 
      } 
    }));
  };

  // Check if Fanart is selected as any art provider
  const isFanartSelected = config.artProviders?.movie === 'fanart' || 
                          config.artProviders?.series === 'fanart' || 
                          config.artProviders?.anime === 'fanart';

  const hasFanartKey = config.apiKeys.fanart && config.apiKeys.fanart.trim() !== '';

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Page Header */}
      <div>
        <h2 className="text-2xl font-semibold">Metadata Providers</h2>
        {/* FIX: Use theme-aware muted text color */}
        <p className="text-muted-foreground mt-1">Choose your preferred source for metadata. Different providers may have better data for certain content.</p>
        <p className="text-xs text-amber-400 mt-4 p-3 bg-amber-900/20 border border-amber-400/30 rounded-lg">
          <strong>Smart Fallback:</strong> If metadata for a title can't be found with your preferred provider (e.g., no TVDB entry for a TMDB movie), the addon will automatically use the item's original source to guarantee you get a result.
        </p>
      </div>

      {/* Provider Selection Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* FIX: Removed all hard-coded colors from Cards and Selects */}
        <Card>
          <CardHeader><CardTitle>Movie Provider</CardTitle><CardDescription>Source for movie data.</CardDescription></CardHeader>
          <CardContent>
            <Select value={config.providers.movie} onValueChange={(val) => handleProviderChange('movie', val)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {movieProviders.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
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
                {seriesProviders.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
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
                {animeProviders.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </div>

      {/* Art Provider Settings */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Art Providers</h3>
        <p className="text-muted-foreground mb-4">Choose your preferred source for images, thumbnails, and posters.</p>
        
        {/* Fanart API Key Warning */}
        {isFanartSelected && !hasFanartKey && (
          <div className="p-4 border border-amber-400/30 bg-amber-900/20 rounded-lg mb-4">
            <div className="flex items-center gap-2 text-amber-400">
              <AlertCircle className="h-4 w-4" />
              <p className="text-sm">
                <strong>Fanart.tv API Key Required:</strong> You've selected Fanart.tv as an art provider. 
                Please add your Fanart.tv API key in the <strong>Integrations</strong> tab to use this service.
              </p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* Movie Art Provider */}
          <Card>
            <CardHeader>
              <CardTitle>Movie Art Provider</CardTitle>
              <CardDescription>Source for movie posters and images.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={config.artProviders?.movie ?? 'meta'} 
                onValueChange={(val) => handleArtProviderChange('movie', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {movieArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Series Art Provider */}
          <Card>
            <CardHeader>
              <CardTitle>Series Art Provider</CardTitle>
              <CardDescription>Source for series posters and images.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={config.artProviders?.series ?? 'meta'} 
                onValueChange={(val) => handleArtProviderChange('series', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {seriesArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          {/* Anime Art Provider */}
          <Card>
            <CardHeader>
              <CardTitle>Anime Art Provider</CardTitle>
              <CardDescription>Source for anime posters and images.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={config.artProviders?.anime ?? 'meta'} 
                onValueChange={(val) => handleArtProviderChange('anime', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {animeArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* TVDB Specific Settings */}
      <Card>
        <CardHeader>
          <CardTitle>TheTVDB Settings</CardTitle>
          <CardDescription>Customize how episode data is fetched from TheTVDB.</CardDescription>
        </CardHeader>
        <CardContent className="max-w-md">
            <Label className="text-lg font-medium">Season Order</Label>
            <Select value={config.tvdbSeasonType} onValueChange={handleSeasonTypeChange}>
              <SelectTrigger className="mt-2"><SelectValue /></SelectTrigger>
              <SelectContent>
                {tvdbSeasonTypes.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {/* FIX: Use theme-aware text color for the helper text */}
            <p className="text-xs text-muted-foreground mt-2">"Aired Order (Default)" or "Official aired" are recommended.</p>
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
          {/* Stream Compatibility ID Dropdown */}
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
              "IMDb" can improve compatibility as it is supported by most streaming addons. Kitsu is recommended when using MAL as meta provider.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
