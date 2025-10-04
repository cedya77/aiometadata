import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useConfig } from '@/contexts/ConfigContext';
import { AppConfig } from '@/contexts/config';
import { allCatalogDefinitions } from '@/data/catalogs';
import { Film, Tv, Sparkles, Users } from 'lucide-react';
import { toast } from 'sonner';

interface PresetConfig {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  badge: string;
  badgeColor: string;
  config: Partial<AppConfig>;
}

const presetConfigs: PresetConfig[] = [
  {
    id: 'movies-shows-only',
    name: 'Movies & Shows Only',
    description: 'Perfect for users who want traditional movies and TV series without anime content. MAL catalogs and anime search are disabled.',
    icon: <Film className="h-6 w-6" />,
    badge: 'Movies & TV',
    badgeColor: 'bg-blue-500',
    config: {
      sfw: true,
      providers: {
        movie: 'tmdb',
        series: 'tvdb',
        anime: 'tvdb', // Fallback, but anime catalogs will be disabled
        anime_id_provider: 'imdb',
        forceAnimeForDetectedImdb: false,
      },
      artProviders: {
        movie: { poster: 'meta', background: 'meta', logo: 'meta' },
        series: { poster: 'meta', background: 'meta', logo: 'meta' },
        anime: { poster: 'tvdb', background: 'tvdb', logo: 'tvdb' },
        englishArtOnly: false,
      },
      search: {
        enabled: true,
        ai_enabled: false,
        providers: {
          movie: 'tmdb.search',
          series: 'tvdb.search',
          anime_movie: 'mal.search.movie',
          anime_series: 'mal.search.series',
        },
        engineEnabled: {
          'tmdb.search': true,
          'tvdb.search': true,
          'tvmaze.search': true,
          'mal.search.movie': false, // Disabled
          'mal.search.series': false, // Disabled
        },
      },
    }
  },
  {
    id: 'movies-shows-anime-mal',
    name: 'Movies & Shows + Anime (MAL)',
    description: 'Best of both worlds - traditional content plus anime with MAL as the anime meta provider. Anime poster provider is MAL, background and logo are IMDb.',
    icon: <Sparkles className="h-6 w-6" />,
    badge: 'Hybrid',
    badgeColor: 'bg-purple-500',
    config: {
      sfw: true,
      providers: {
        movie: 'tmdb',
        series: 'tvdb',
        anime: 'mal',
        anime_id_provider: 'kitsu',
        forceAnimeForDetectedImdb: false,
      },
      artProviders: {
        movie: { poster: 'meta', background: 'meta', logo: 'meta' },
        series: { poster: 'meta', background: 'meta', logo: 'meta' },
        anime: { poster: 'mal', background: 'imdb', logo: 'imdb' },
        englishArtOnly: false,
      },
      search: {
        enabled: true,
        ai_enabled: false,
        providers: {
          movie: 'tmdb.search',
          series: 'tvdb.search',
          anime_movie: 'mal.search.movie',
          anime_series: 'mal.search.series',
        },
        engineEnabled: {
          'tmdb.search': true,
          'tvdb.search': true,
          'tvmaze.search': true,
          'mal.search.movie': true,
          'mal.search.series': true,
        },
      },
    }
  },
  {
    id: 'movies-shows-anime-tvdb',
    name: 'Movies & Shows + Anime (TVDB)',
    description: 'Similar to the MAL preset but uses TVDB as the anime meta provider with Kitsu as compatibility ID. Same art settings as MAL preset.',
    icon: <Tv className="h-6 w-6" />,
    badge: 'Hybrid TVDB',
    badgeColor: 'bg-green-500',
    config: {
      sfw: true,
      providers: {
        movie: 'tmdb',
        series: 'tvdb',
        anime: 'tvdb',
        anime_id_provider: 'kitsu',
        forceAnimeForDetectedImdb: false,
      },
      artProviders: {
        movie: { poster: 'meta', background: 'meta', logo: 'meta' },
        series: { poster: 'meta', background: 'meta', logo: 'meta' },
        anime: { poster: 'mal', background: 'imdb', logo: 'imdb' },
        englishArtOnly: false,
      },
      search: {
        enabled: true,
        ai_enabled: false,
        providers: {
          movie: 'tmdb.search',
          series: 'tvdb.search',
          anime_movie: 'mal.search.movie',
          anime_series: 'mal.search.series',
        },
        engineEnabled: {
          'tmdb.search': true,
          'tvdb.search': true,
          'tvmaze.search': true,
          'mal.search.movie': true,
          'mal.search.series': true,
        },
      },
    }
  },
  {
    id: 'anime-lovers-mal',
    name: 'Anime Lovers (MAL Grouped Seasons)',
    description: 'Perfect for anime enthusiasts who want grouped seasons with MAL. Anime override is enabled, IMDb ID for Catalog/Search is turned on. Anime poster provider is TVDB, logo and background are IMDb.',
    icon: <Users className="h-6 w-6" />,
    badge: 'Anime Focus',
    badgeColor: 'bg-pink-500',
    config: {
      sfw: true,
      providers: {
        movie: 'tmdb',
        series: 'tvdb',
        anime: 'tvdb', // TVDB works better with useImdbIdForCatalogAndSearch: true
        anime_id_provider: 'kitsu',
        forceAnimeForDetectedImdb: true, // Anime override enabled
      },
      artProviders: {
        movie: { poster: 'meta', background: 'meta', logo: 'meta' },
        series: { poster: 'meta', background: 'meta', logo: 'meta' },
        anime: { poster: 'tvdb', background: 'imdb', logo: 'imdb' },
        englishArtOnly: false,
      },
      mal: {
        skipFiller: false,
        skipRecap: false,
        allowEpisodeMarking: false,
        useImdbIdForCatalogAndSearch: true, // Use IMDb ID for Catalog/Search
      },
      search: {
        enabled: true,
        ai_enabled: false,
        providers: {
          movie: 'tmdb.search',
          series: 'tvdb.search',
          anime_movie: 'mal.search.movie',
          anime_series: 'mal.search.series',
        },
        engineEnabled: {
          'tmdb.search': true,
          'tvdb.search': true,
          'tvmaze.search': true,
          'mal.search.movie': true,
          'mal.search.series': true,
        },
      },
    }
  }
];

export function PresetManager() {
  const { config, setConfig } = useConfig();
  const [includeAdult, setIncludeAdult] = useState(config.includeAdult || false);

  const handleAdultContentToggle = (checked: boolean) => {
    setIncludeAdult(checked);
    // Also update the config immediately so it's reflected in other sections
    setConfig(prev => ({
      ...prev,
      includeAdult: checked,
      sfw: checked ? false : (prev.sfw || true)
    }));
  };

  const applyPreset = (preset: PresetConfig) => {
    setConfig(prevConfig => {
      // Start with current config
      const newConfig = { ...prevConfig };

      // Apply preset-specific settings
      if (preset.config.providers) {
        newConfig.providers = { ...prevConfig.providers, ...preset.config.providers };
      }
      if (preset.config.artProviders) {
        newConfig.artProviders = { ...prevConfig.artProviders, ...preset.config.artProviders };
      }
      if (preset.config.search) {
        newConfig.search = { ...prevConfig.search, ...preset.config.search };
      }
      if (preset.config.mal) {
        newConfig.mal = { ...prevConfig.mal, ...preset.config.mal };
      }
      if (preset.config.sfw !== undefined) {
        newConfig.sfw = preset.config.sfw;
      }
      
      // Apply adult content settings based on toggle
      newConfig.includeAdult = includeAdult;
      newConfig.sfw = includeAdult ? false : (preset.config.sfw !== undefined ? preset.config.sfw : true);

      // Handle catalog enabling/disabling based on preset
      const updatedCatalogs = newConfig.catalogs.map(catalog => {
        const isMalCatalog = catalog.source === 'mal';
        const isAnimeCatalog = catalog.type === 'anime';
        
        // For "Movies & Shows Only" preset, disable all MAL and anime catalogs
        if (preset.id === 'movies-shows-only' && (isMalCatalog || isAnimeCatalog)) {
          return { ...catalog, enabled: false, showInHome: false };
        }
        
        // For other presets, ensure MAL/anime catalogs are properly enabled based on defaults
        if (isMalCatalog || isAnimeCatalog) {
          const defaultCatalog = allCatalogDefinitions.find(def => 
            def.id === catalog.id && def.type === catalog.type
          );
          if (defaultCatalog && defaultCatalog.isEnabledByDefault) {
            return { 
              ...catalog, 
              enabled: true, 
              showInHome: defaultCatalog.showOnHomeByDefault || false 
            };
          }
        }
        
        return catalog;
      });

      newConfig.catalogs = updatedCatalogs;

      toast.success('Preset applied successfully!', {
        description: `Applied "${preset.name}" configuration. Don't forget to save in the Configuration Manager.`,
        duration: 5000,
      });

      return newConfig;
    });
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold">Configuration Presets</h2>
        <p className="text-muted-foreground">
          Choose a preset to quickly configure your addon for different use cases. Each preset optimizes settings for specific content preferences.
        </p>
      </div>

      {/* Adult Content Toggle */}
      <Card>
        <CardContent className="p-4 pt-6 flex items-center justify-between">
          <div>
            <Label htmlFor="include-adult" className="text-lg font-medium">Include Adult Content</Label>
            <p className="text-sm text-muted-foreground">
              When enabled, allows adult content in catalogs and search results. When disabled, content is filtered for safe viewing.
            </p>
          </div>
          <Switch 
            id="include-adult"
            checked={includeAdult} 
            onCheckedChange={handleAdultContentToggle} 
          />
        </CardContent>
      </Card>


      <div className="grid gap-4 md:grid-cols-2">
        {presetConfigs.map((preset) => (
          <Card key={preset.id} className="relative overflow-hidden">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center space-x-3">
                  <div className="p-2 rounded-lg bg-muted">
                    {preset.icon}
                  </div>
                  <div>
                    <CardTitle className="text-lg">{preset.name}</CardTitle>
                    <Badge className={`mt-1 ${preset.badgeColor} text-white`}>
                      {preset.badge}
                    </Badge>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <CardDescription className="mb-4 text-sm leading-relaxed">
                {preset.description}
              </CardDescription>
              <Button 
                onClick={() => applyPreset(preset)}
                className="w-full"
                variant="outline"
              >
                Apply This Preset
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-6 p-4 bg-muted/50 rounded-lg">
        <h3 className="font-semibold mb-2">About Presets</h3>
        <p className="text-sm text-muted-foreground">
          Presets are starting points that configure multiple settings at once. You can always fine-tune individual settings 
          in the other configuration sections after applying a preset. Each preset includes:
        </p>
        <ul className="text-sm text-muted-foreground mt-2 ml-4 list-disc space-y-1">
          <li>Meta provider configurations (TMDB, TVDB, MAL)</li>
          <li>Art provider settings (posters, backgrounds, logos)</li>
          <li>Catalog enabling/disabling (especially MAL anime catalogs)</li>
          <li>Search engine configurations</li>
          <li>Anime-specific settings (compatibility IDs, overrides)</li>
        </ul>
      </div>
    </div>
  );
}
