import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useConfig } from '@/contexts/ConfigContext';
import { AlertCircle } from 'lucide-react';

const movieArtProviders = [
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'tvdb', label: 'TheTVDB' },
  { value: 'fanart', label: 'Fanart.tv' },
  { value: 'imdb', label: 'Internet Movie Database (IMDB)' },
];

const seriesArtProviders = [
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'tvdb', label: 'TheTVDB' },
  { value: 'fanart', label: 'Fanart.tv' },
  { value: 'imdb', label: 'Internet Movie Database (IMDB)' },
];

const animeArtProviders = [
  { value: 'mal', label: 'MyAnimeList' },
  { value: 'anilist', label: 'AniList' },
  { value: 'kitsu', label: 'Kitsu' },
  { value: 'tvdb', label: 'TheTVDB' },
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'fanart', label: 'Fanart.tv' },
  { value: 'imdb', label: 'Internet Movie Database (IMDB)' },
];

const animeBackgroundArtProviders = [
  { value: 'mal', label: 'MyAnimeList' },
  { value: 'anilist', label: 'AniList' },
  { value: 'kitsu', label: 'Kitsu' },
  { value: 'tvdb', label: 'TheTVDB' },
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'fanart', label: 'Fanart.tv' },
  { value: 'imdb', label: 'Internet Movie Database (IMDB) (Recommended)' },
];

const animeLogoArtProviders = [
  { value: 'imdb', label: 'Internet Movie Database (IMDB) (Recommended)' },
  { value: 'tvdb', label: 'TheTVDB' },
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'fanart', label: 'Fanart.tv' },
];

export function ArtProviderSettings() {
  const { config, setConfig, hasBuiltInTvdb } = useConfig();
  const hasTvdbKey = !!config.apiKeys?.tvdb?.trim() || hasBuiltInTvdb;

  const handleArtProviderChange = (
    contentType: 'movie' | 'series' | 'anime',
    artType: 'poster' | 'background' | 'logo',
    value: string
  ) => {
    setConfig(prev => ({ 
      ...prev, 
      artProviders: { 
        ...prev.artProviders,
        [contentType]: {
          ...(typeof prev.artProviders?.[contentType] === 'object' 
            ? prev.artProviders[contentType] 
            : { poster: 'meta', background: 'meta', logo: 'meta' }),
          [artType]: value
        }
      } 
    }));
  };

  const handleEnglishArtOnlyChange = (value: boolean) => {
    setConfig(prev => ({
      ...prev,
      artProviders: {
        ...prev.artProviders,
        englishArtOnly: value
      }
    }));
  };

  const isFanartSelected = () => {
    const artProviders = config.artProviders;
    if (!artProviders) return false;
    
    return Object.values(artProviders).some(contentType => 
      contentType && typeof contentType === 'object' && 
      Object.values(contentType).includes('fanart')
    );
  };

  const hasFanartKey = config.apiKeys.fanart && config.apiKeys.fanart.trim() !== '';

  const getArtProviders = (contentType: 'movie' | 'series' | 'anime', artType: 'poster' | 'background' | 'logo') => {
    switch (contentType) {
      case 'movie':
        return movieArtProviders;
      case 'series':
        return seriesArtProviders;
      case 'anime':
        if (artType === 'background') {
          return animeBackgroundArtProviders;
        } else if (artType === 'logo') {
          return animeLogoArtProviders;
        } else {
          return animeArtProviders;
        }
      default:
        return [];
    }
  };

  const getCurrentValue = (contentType: 'movie' | 'series' | 'anime', artType: 'poster' | 'background' | 'logo') => {
    const contentTypeConfig = config.artProviders?.[contentType];
    if (typeof contentTypeConfig === 'string') {
      // Legacy format - return the single value for all art types
      return contentTypeConfig;
    }
    if (contentTypeConfig && typeof contentTypeConfig === 'object') {
      return contentTypeConfig[artType] || 'meta';
    }
    return 'meta';
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Art Providers</h2>
        <p className="text-muted-foreground mt-1">
          Choose your preferred sources for different types of artwork. You can select different providers for posters, backgrounds, and logos.
        </p>
        
        {/* Search Notice */}
        <div className="flex items-start gap-2 mt-4 p-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg">
          <AlertCircle className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-blue-800 dark:text-blue-200">
            <strong>Note:</strong> Art provider settings apply to catalogs and detail pages, but not to search results. Search uses the selected search engine's poster sources for faster performance. <strong>When using rating posters (RPDB or Top Poster API), posters come from the rating provider rather than the art provider settings.</strong>
          </p>
        </div>
        
        {/* English Art Only Toggle */}
        <Card className="mt-6">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="english-art-only" className="text-base font-medium">
                  English Art Only
                </Label>
                <p className="text-sm text-muted-foreground">
                  Force all artwork to be in English language, regardless of your language setting.
                </p>
              </div>
              <Switch
                id="english-art-only"
                checked={config.artProviders?.englishArtOnly || false}
                onCheckedChange={handleEnglishArtOnlyChange}
              />
            </div>
          </CardContent>
        </Card>

        {isFanartSelected() && !hasFanartKey && (
          <div className="p-4 border border-amber-400/30 bg-amber-900/20 rounded-lg mt-4">
            <div className="flex items-center gap-2 text-amber-400">
              <AlertCircle className="h-4 w-4" />
              <p className="text-sm">
                <strong>Fanart.tv API Key Required:</strong> You've selected Fanart.tv as an art provider. 
                Please add your Fanart.tv API key in the <strong>Integrations</strong> tab to use this service.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Movies Art Providers */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Movies</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Poster Provider</CardTitle>
              <CardDescription>Source for movie posters.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={getCurrentValue('movie', 'poster')} 
                onValueChange={(val) => handleArtProviderChange('movie', 'poster', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {movieArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                      {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Background Provider</CardTitle>
              <CardDescription>Source for movie backgrounds.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={getCurrentValue('movie', 'background')} 
                onValueChange={(val) => handleArtProviderChange('movie', 'background', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {movieArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                      {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Logo Provider</CardTitle>
              <CardDescription>Source for movie logos.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={getCurrentValue('movie', 'logo')} 
                onValueChange={(val) => handleArtProviderChange('movie', 'logo', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {movieArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                      {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Series Art Providers */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Series</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Poster Provider</CardTitle>
              <CardDescription>Source for series posters.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={getCurrentValue('series', 'poster')} 
                onValueChange={(val) => handleArtProviderChange('series', 'poster', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {seriesArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                      {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Background Provider</CardTitle>
              <CardDescription>Source for series backgrounds.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={getCurrentValue('series', 'background')} 
                onValueChange={(val) => handleArtProviderChange('series', 'background', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {seriesArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                      {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Logo Provider</CardTitle>
              <CardDescription>Source for series logos.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={getCurrentValue('series', 'logo')} 
                onValueChange={(val) => handleArtProviderChange('series', 'logo', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {seriesArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                      {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Anime Art Providers */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Anime</h3>
        
        {/* Warning when IMDb settings are affecting anime art providers */}
        {(config.mal?.useImdbIdForCatalogAndSearch || config.providers?.forceAnimeForDetectedImdb) && (
          <div className="flex items-start gap-2 mb-4 p-4 bg-amber-50 dark:bg-amber-950 border-2 border-amber-400 dark:border-amber-600 rounded-lg">
            <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-amber-800 dark:text-amber-200">
              <p className="font-semibold mb-1">⚠️ Important: Anime Art Providers Limited</p>
              <p>
                {config.mal?.useImdbIdForCatalogAndSearch && config.providers?.forceAnimeForDetectedImdb 
                  ? 'Both "Use IMDb ID for Catalog/Search" and "Anime Detection Override" are enabled. Most anime will use the Movie/Series art providers instead of these Anime art providers.'
                  : config.mal?.useImdbIdForCatalogAndSearch
                  ? '"Use IMDb ID for Catalog/Search" is enabled in MAL settings. Anime in catalogs/search will use the Movie/Series art providers instead of these Anime art providers.'
                  : '"Anime Detection Override" is enabled in Providers settings. Detected anime with IMDb IDs will use the Movie/Series art providers instead of these Anime art providers.'}
              </p>
            </div>
          </div>
        )}
        
        <div className="flex items-start gap-2 mb-4 p-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg">
          <AlertCircle className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-blue-800 dark:text-blue-200">
            These settings apply only to anime using MAL, AniList, Kitsu, or AniDB as metadata ID. Anime using IMDB IDs will use the Movie or Series art providers instead depending on the type.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Poster Provider</CardTitle>
              <CardDescription>Source for anime posters.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={getCurrentValue('anime', 'poster')} 
                onValueChange={(val) => handleArtProviderChange('anime', 'poster', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {getArtProviders('anime', 'poster').map(p => (
                    <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                      {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Background Provider</CardTitle>
              <CardDescription>Source for anime backgrounds.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={getCurrentValue('anime', 'background')} 
                onValueChange={(val) => handleArtProviderChange('anime', 'background', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {getArtProviders('anime', 'background').map(p => (
                    <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                      {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Logo Provider</CardTitle>
              <CardDescription>Source for anime logos.</CardDescription>
            </CardHeader>
            <CardContent>
              <Select 
                value={getCurrentValue('anime', 'logo')} 
                onValueChange={(val) => handleArtProviderChange('anime', 'logo', val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="meta">Meta Provider (default)</SelectItem>
                  {getArtProviders('anime', 'logo').map(p => (
                    <SelectItem key={p.value} value={p.value} disabled={p.value === 'tvdb' && !hasTvdbKey}>
                      {p.label}{p.value === 'tvdb' && !hasTvdbKey && ' (API key required)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
