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
  { value: 'tvdb', label: 'TheTVDB (Recommended)' },
  { value: 'tmdb', label: 'The Movie Database (TMDB)' },
  { value: 'fanart', label: 'Fanart.tv' },
  { value: 'imdb', label: 'Internet Movie Database (IMDB)' },
];

export function ArtProviderSettings() {
  const { config, setConfig } = useConfig();

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

  const getArtProviders = (contentType: 'movie' | 'series' | 'anime') => {
    switch (contentType) {
      case 'movie':
        return movieArtProviders;
      case 'series':
        return seriesArtProviders;
      case 'anime':
        return animeArtProviders;
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
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
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
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
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
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
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
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
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

      {/* Anime Art Providers */}
      <div>
        <h3 className="text-xl font-semibold mb-4">Anime</h3>
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
                  {animeArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
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
                  {animeArtProviders.map(p => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
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
    </div>
  );
}
