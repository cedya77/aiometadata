import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useConfig } from '@/contexts/ConfigContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { allSearchProviders } from '@/data/catalogs';


export function SearchSettings() {
  const { config, setConfig } = useConfig();

  const handleSearchEnabledChange = (checked: boolean) => {
    setConfig(prev => ({ ...prev, search: { ...prev.search, enabled: checked } }));
  };

  const handleAiToggle = (checked: boolean) => {
    setConfig(prev => ({ ...prev, search: { ...prev.search, ai_enabled: checked } }));
  };

  const handleProviderChange = (
    type: 'movie' | 'series' | 'anime_movie' | 'anime_series', 
    value: string
  ) => {
    setConfig(prev => ({
        ...prev,
        search: { 
            ...prev.search, 
            providers: { 
                ...prev.search.providers, 
                [type]: value 
            } 
        }
    }));
  };

  const handleEngineEnabledChange = (engine: string, checked: boolean) => {
    setConfig(prev => ({
      ...prev,
      search: {
        ...prev.search,
        engineEnabled: {
          ...prev.search.engineEnabled,
          [engine]: checked,
        },
      },
    }));
  };

  const movieSearchProviders = allSearchProviders.filter(p => p.mediaType.includes('movie'));
  const seriesSearchProviders = allSearchProviders.filter(p => p.mediaType.includes('series'));
  const animeSearchProviders = allSearchProviders.filter(
    p => p.mediaType.includes('anime_movie') || p.mediaType.includes('anime_series')
  );

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Search Settings</h2>
        <p className="text-muted-foreground mt-1">Configure your addon's search functionality.</p>
      </div>

      {/* --- MASTER TOGGLE --- */}
      <Card>
        <CardContent className="p-4 pt-6 flex items-center justify-between">
            <div>
                <Label htmlFor="search-enabled" className="text-lg font-medium">Enable Search Catalogs</Label>
                <p className="text-sm text-muted-foreground">Adds "Search" catalogs to your Discover screen.</p>
            </div>
            <Switch 
              id="search-enabled"
              checked={config.search.enabled} 
              onCheckedChange={handleSearchEnabledChange} 
            />
        </CardContent>
      </Card>
      
      {/* --- All other settings are conditional on the master toggle --- */}
      {config.search.enabled && (
        <div className="space-y-8 pl-4 sm:pl-6 border-l-2 border-border">
            {/* AI Enhancement Card */}
            {/*<Card>
                <CardHeader>
                  <CardTitle>AI-Powered Search</CardTitle>
                  <CardDescription>
                    Use Google Gemini to understand natural language queries (e.g., "movies about time travel"). This requires a Gemini API key.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between">
                    <Label htmlFor="ai-enabled" className="text-lg font-medium">Enable AI Enhancement</Label>
                    <Switch 
                      id="ai-enabled"
                      checked={config.search.ai_enabled} 
                      onCheckedChange={handleAiToggle} 
                    />
                </CardContent>
            </Card>*/}
            
            {/* Primary Keyword Engine Card */}
            <Card>
                <CardHeader>
                    <CardTitle>Primary Keyword Engines</CardTitle>
                    <CardDescription>
                        Choose the default engine for basic keyword searches. The AI search uses this engine to find items based on its suggestions.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    {/* Movie Search Provider */}
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                        <Label className="text-lg font-medium">Movies Engine:</Label>
                        <div className="flex items-center gap-3 w-full sm:w-[280px]">
                            <Select value={config.search.providers.movie} onValueChange={(val) => handleProviderChange('movie', val)}>
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {movieSearchProviders.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                                </SelectContent>
                            </Select>
                            <Switch
                                checked={config.search.engineEnabled?.[config.search.providers.movie] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange(config.search.providers.movie, checked)}
                                aria-label="Enable this engine"
                            />
                        </div>
                    </div>
                    {/* Series Search Provider */}
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                        <Label className="text-lg font-medium">Series Engine:</Label>
                        <div className="flex items-center gap-3 w-full sm:w-[280px]">
                            <Select value={config.search.providers.series} onValueChange={(val) => handleProviderChange('series', val)}>
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {seriesSearchProviders.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                                </SelectContent>
                            </Select>
                            <Switch
                                checked={config.search.engineEnabled?.[config.search.providers.series] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange(config.search.providers.series, checked)}
                                aria-label="Enable this engine"
                            />
                        </div>
                    </div>
                    {/* Anime (Series) Search Provider */}
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                        <Label className="text-lg font-medium">Anime (Series) Engine:</Label>
                        <div className="flex items-center gap-3 w-full sm:w-[280px]">
                            <div className="flex-1 text-sm text-muted-foreground border border-input rounded-md bg-stone-900 px-3 py-2 h-10 flex items-center">
                                {animeSearchProviders.find(p => p.value === 'mal.search.series')?.label || 'MAL Keyword (Series)'}
                            </div>
                            <Switch
                                checked={config.search.engineEnabled?.['mal.search.series'] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange('mal.search.series', checked)}
                                aria-label="Enable this engine"
                            />
                        </div>
                    </div>
                    {/* Anime (Movies) Search Provider */}
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                        <Label className="text-lg font-medium">Anime (Movies) Engine:</Label>
                        <div className="flex items-center gap-3 w-full sm:w-[280px]">
                            <div className="flex-1 text-sm text-muted-foreground border border-input rounded-md bg-stone-900 px-3 py-2 h-10 flex items-center">
                                {animeSearchProviders.find(p => p.value === 'mal.search.movie')?.label || 'MAL Keyword (Movies)'}
                            </div>
                            <Switch
                                checked={config.search.engineEnabled?.['mal.search.movie'] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange('mal.search.movie', checked)}
                                aria-label="Enable this engine"
                            />
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
      )}
    </div>
  );
}
