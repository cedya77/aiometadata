import React, { useState, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfig } from '@/contexts/ConfigContext';
import { AppConfig, CatalogConfig } from '@/contexts/config';
import { allCatalogDefinitions } from '@/data/catalogs';
import { Film, Tv, Sparkles, Users } from 'lucide-react';
import { toast } from 'sonner';
import { MDBListAPIKeyModal } from '@/components/MDBListAPIKeyModal';

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
          'tvdb.collections.search': false,
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
    description: 'Best of both worlds - traditional content plus anime with Kitsu as the anime meta provider. Anime poster provider is MAL, background and logo are IMDb.',
    icon: <Sparkles className="h-6 w-6" />,
    badge: 'Hybrid',
    badgeColor: 'bg-purple-500',
    config: {
      sfw: true,
      providers: {
        movie: 'tmdb',
        series: 'tvdb',
        anime: 'kitsu',
        anime_id_provider: 'kitsu',
        forceAnimeForDetectedImdb: false,
      },
      artProviders: {
        movie: { poster: 'meta', background: 'meta', logo: 'meta' },
        series: { poster: 'meta', background: 'meta', logo: 'meta' },
        anime: { poster: 'meta', background: 'imdb', logo: 'imdb' },
        englishArtOnly: false,
      },
      search: {
        enabled: true,
        ai_enabled: false,
        providers: {
          movie: 'tmdb.search',
          series: 'tvdb.search',
          anime_movie: 'kitsu.search.movie',
          anime_series: 'kitsu.search.series',
        },
        engineEnabled: {
          'tmdb.search': true,
          'tvdb.search': true,
          'tvdb.collections.search': false,
          'tvmaze.search': true,
          'kitsu.search.movie': true,
          'kitsu.search.series': true,
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
          anime_movie: 'kitsu.search.movie',
          anime_series: 'kitsu.search.series',
        },
        engineEnabled: {
          'tmdb.search': true,
          'tvdb.search': true,
          'tvdb.collections.search': false,
          'tvmaze.search': true,
          'kitsu.search.movie': true,
          'kitsu.search.series': true,
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
        series: { poster: 'meta', background: 'imdb', logo: 'imdb' },
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
          anime_movie: 'kitsu.search.movie',
          anime_series: 'kitsu.search.series',
        },
        engineEnabled: {
          'tmdb.search': true,
          'tvdb.search': true,
          'tvdb.collections.search': false,
          'tvmaze.search': true,
          'kitsu.search.movie': true,
          'kitsu.search.series': true,
        },
      },
    }
  }
];

export function PresetManager() {
  const { config, setConfig, catalogTTL } = useConfig();
  const [includeAdult, setIncludeAdult] = useState(config.includeAdult || false);
  const [includePopularLists, setIncludePopularLists] = useState(false);
  const [selectedCurators, setSelectedCurators] = useState<Set<string>>(new Set());
  const [userListSort, setUserListSort] = useState<'ranked' | 'name' | 'created'>('ranked');
  const [overrideMovieType, setOverrideMovieType] = useState(!!config.displayTypeOverrides?.movie);
  const [movieDisplayType, setMovieDisplayType] = useState(config.displayTypeOverrides?.movie || '');
  const [overrideSeriesType, setOverrideSeriesType] = useState(!!config.displayTypeOverrides?.series);
  const [seriesDisplayType, setSeriesDisplayType] = useState(config.displayTypeOverrides?.series || '');
  
  // MDBList API key modal state
  const [showMDBListModal, setShowMDBListModal] = useState(false);
  const [isValidatingApiKey, setIsValidatingApiKey] = useState(false);
  const mdblistModalResolve = useRef<((apiKey: string) => void) | null>(null);
  const mdblistModalReject = useRef<((error: Error) => void) | null>(null);

  const handleAdultContentToggle = (checked: boolean) => {
    setIncludeAdult(checked);
    // Also update the config immediately so it's reflected in other sections
    setConfig(prev => ({
      ...prev,
      includeAdult: checked,
      sfw: checked ? false : (prev.sfw || true)
    }));
  };

  const handleDisplayTypeOverrides = () => {
    setConfig(prev => ({
      ...prev,
      displayTypeOverrides: {
        movie: overrideMovieType && movieDisplayType.trim() ? movieDisplayType.trim() : undefined,
        series: overrideSeriesType && seriesDisplayType.trim() ? seriesDisplayType.trim() : undefined,
      }
    }));
  };

  const applyDisplayTypeOverridesToCatalogs = () => {
    setConfig(prev => {
      const overrides = {
        movie: overrideMovieType && movieDisplayType.trim() ? movieDisplayType.trim() : undefined,
        series: overrideSeriesType && seriesDisplayType.trim() ? seriesDisplayType.trim() : undefined,
      };

      // Apply overrides to existing catalogs
      const updatedCatalogs = prev.catalogs.map(catalog => {
        // Determine what the displayType should be for this catalog
        let newDisplayType: string | undefined = catalog.displayType;

        if (catalog.type === 'movie') {
          newDisplayType = overrides.movie;
        } else if (catalog.type === 'series') {
          newDisplayType = overrides.series;
        }

        // If newDisplayType is undefined, remove the property entirely
        if (newDisplayType === undefined) {
          const { displayType: _, ...catalogWithoutDisplayType } = catalog;
          return catalogWithoutDisplayType as CatalogConfig;
        }
        
        // Otherwise, set the displayType
        return { ...catalog, displayType: newDisplayType };
      });

      toast.success('Display type overrides applied!', {
        description: 'Your existing catalogs have been updated with the new display types.'
      });

      return {
        ...prev,
        displayTypeOverrides: overrides,
        catalogs: updatedCatalogs,
      };
    });
  };

  const handleCuratorSelection = (username: string, checked: boolean) => {
    const newSelection = new Set(selectedCurators);
    if (checked) {
      newSelection.add(username);
    } else {
      newSelection.delete(username);
    }
    setSelectedCurators(newSelection);
  };

  const popularUsers = [
    { username: 'danaramapyjama', name: 'Dan Pyjama', description: 'Curated lists of films by a Pyjama wearer for Pyjama wearers' },
    { username: 'tvgeniekodi', name: 'Mr. Professor', description: 'Curated TV and movie lists' },
    { username: 'snoak', name: 'Snoak', description: 'Quality content collections' },
    { username: 'garycrawfordgc', name: 'Gary Crawford', description: 'Expert curated lists' }
  ];

  /**
   * Prompts the user to enter their MDBList API key via a modal dialog.
   * Returns a promise that resolves with the API key or rejects if cancelled.
   */
  const promptForMDBListAPIKey = (): Promise<string> => {
    return new Promise((resolve, reject) => {
      // Store the resolve/reject functions for later use
      mdblistModalResolve.current = resolve;
      mdblistModalReject.current = reject;
      
      // Show the modal
      setShowMDBListModal(true);
    });
  };

  /**
   * Handles submission of the MDBList API key from the modal.
   * Saves the key to config and resolves the promise.
   */
  const handleMDBListAPIKeySubmit = (apiKey: string) => {
    setIsValidatingApiKey(true);
    
    // Save API key to config
    setConfig(prev => ({
      ...prev,
      apiKeys: {
        ...prev.apiKeys,
        mdblist: apiKey
      }
    }));
    
    // Close modal and resolve promise
    setShowMDBListModal(false);
    setIsValidatingApiKey(false);
    
    if (mdblistModalResolve.current) {
      mdblistModalResolve.current(apiKey);
      mdblistModalResolve.current = null;
      mdblistModalReject.current = null;
    }
  };

  /**
   * Handles cancellation of the MDBList API key modal.
   * Rejects the promise with a cancellation error.
   */
  const handleMDBListAPIKeyCancel = () => {
    setShowMDBListModal(false);
    setIsValidatingApiKey(false);
    
    if (mdblistModalReject.current) {
      mdblistModalReject.current(new Error('User cancelled API key input'));
      mdblistModalResolve.current = null;
      mdblistModalReject.current = null;
    }
  };

  const fetchAndImportPopularLists = async () => {
    if (selectedCurators.size === 0) {
      toast.error("Please select at least one curator to import lists from.");
      return;
    }

    // Validate MDBList API key - prompt if missing
    let apiKey = config.apiKeys.mdblist;
    if (!apiKey) {
      try {
        apiKey = await promptForMDBListAPIKey();
      } catch (error) {
        // User cancelled the modal
        toast.info("Popular lists import cancelled", {
          description: "MDBList API key is required to import popular lists."
        });
        return;
      }
    }

    try {
      const allLists: any[] = [];
      const selectedUsers = popularUsers.filter(user => selectedCurators.has(user.username));
      let hasAuthError = false;
      
      for (const user of selectedUsers) {
        try {
          const response = await fetch(`https://api.mdblist.com/lists/user/${user.username}?apikey=${apiKey}&sort=${userListSort}`);
          
          // Check for authentication/authorization errors
          if (response.status === 401 || response.status === 403) {
            hasAuthError = true;
            console.error(`Authentication failed for MDBList API (status ${response.status})`);
            break; // Stop trying other users if API key is invalid
          }
          
          if (response.ok) {
            const userLists = await response.json();
            if (Array.isArray(userLists)) {
              let filteredLists = userLists;
              
              // For danaramapyjama, only include lists containing "wearers" in the name
              if (user.username === 'danaramapyjama') {
                filteredLists = userLists.filter((list: any) => 
                  list.name && list.name.toLowerCase().includes('wearers')
                );
              }
              
              const listsWithUser = filteredLists.map((list: any) => ({
                ...list,
                user: user.name
              }));
              allLists.push(...listsWithUser);
            }
          } else {
            console.warn(`Failed to fetch lists for user ${user.username}: HTTP ${response.status}`);
          }
        } catch (error) {
          console.warn(`Failed to fetch lists for user ${user.username}:`, error);
        }
      }
      
      // Check if we had an authentication error
      if (hasAuthError) {
        // Remove the invalid API key from config so user can retry
        setConfig(prev => ({
          ...prev,
          apiKeys: {
            ...prev.apiKeys,
            mdblist: ''
          }
        }));
        
        toast.error("Invalid MDBList API key", {
          description: "The API key you provided is not valid. Please check your key and try again."
        });
        return;
      }

      if (allLists.length > 0) {
        setConfig(prev => {
          // Remove any existing MDBList catalogs to ensure clean slate
          const catalogsWithoutMDBList = prev.catalogs.filter(c => !c.id.startsWith('mdblist.'));
          let newCatalogs = [...catalogsWithoutMDBList];
          let newListsAddedCount = 0;

          allLists.forEach(list => {
            const type = list.mediatype === "movie" ? "movie" : "series";
            const catalogId = `mdblist.${list.id}`;
            
            // Apply display type overrides
            let displayType = undefined;
            
            // Special case: danaramapyjama always uses "film" for movies
            if (list.user === 'Dan Pyjama' && type === 'movie') {
              displayType = 'film';
            } 
            // Apply global display type overrides if configured
            if (prev.displayTypeOverrides) {
              if (type === 'movie' && prev.displayTypeOverrides.movie) {
                displayType = prev.displayTypeOverrides.movie;
              } else if (type === 'series' && prev.displayTypeOverrides.series) {
                displayType = prev.displayTypeOverrides.series;
              }
            }
            
            const newCatalog = {
              id: catalogId,
              type: type as 'movie' | 'series' | 'anime',
              name: list.name,
              enabled: true,
              showInHome: true,
              source: 'mdblist' as const,
              sort: 'default' as const,
              order: 'asc' as const,
              cacheTTL: catalogTTL,
              genreSelection: 'standard' as const, // Default to standard genres for preset imports
              enableRPDB: true,
              displayType,
            };
            newCatalogs.push(newCatalog);
            newListsAddedCount++;
          });

          return {
            ...prev,
            catalogs: newCatalogs,
          };
        });

        const selectedNames = selectedUsers.map(u => u.name).join(', ');
        toast.success("Popular lists added", {
          description: `Added ${allLists.length} curated lists from ${selectedNames}`
        });
      } else {
        toast.info("No popular lists found", {
          description: "No public lists available from the featured curators"
        });
      }
    } catch (error) {
      console.error("Error fetching popular lists:", error);
      toast.error("Failed to import popular lists", {
        description: "Make sure your MDBList API key is valid"
      });
    }
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

      // Reset catalogs to clean slate based on preset
      let resetCatalogs = allCatalogDefinitions.map(def => ({
        id: def.id,
        name: def.name,
        type: def.type,
        source: def.source,
        enabled: def.isEnabledByDefault || false,
        showInHome: def.showOnHomeByDefault || false,
        sort: 'default' as const,
        order: 'asc' as const,
      }));

      // Apply preset-specific catalog modifications
      if (preset.id === 'movies-shows-only') {
        // Disable all MAL and anime catalogs for movies & shows only preset
        resetCatalogs = resetCatalogs.map(catalog => {
          const isMalCatalog = catalog.source === 'mal';
          const isAnimeCatalog = catalog.type === 'anime';
          if (isMalCatalog || isAnimeCatalog) {
            return { ...catalog, enabled: false, showInHome: false };
          }
          return catalog;
        });
      }

      // Apply display type overrides to all catalogs if configured
      if (config.displayTypeOverrides) {
        resetCatalogs = resetCatalogs.map(catalog => {
          let displayType = undefined;
          
          // Apply movie override
          if (config.displayTypeOverrides.movie && catalog.type === 'movie') {
            displayType = config.displayTypeOverrides.movie;
          }
          
          // Apply series override
          if (config.displayTypeOverrides.series && catalog.type === 'series') {
            displayType = config.displayTypeOverrides.series;
          }
          
          return displayType ? { ...catalog, displayType } : catalog;
        });
      }
      
      newConfig.catalogs = resetCatalogs;

      // Apply popular lists if enabled and curators are selected
      if (includePopularLists && selectedCurators.size > 0) {
        // Import popular lists after a short delay to allow preset to be applied first
        setTimeout(() => {
          fetchAndImportPopularLists();
        }, 500);
      }

      const curatorNames = includePopularLists && selectedCurators.size > 0 
        ? popularUsers.filter(u => selectedCurators.has(u.username)).map(u => u.name).join(', ')
        : '';
      
      toast.success('Preset applied successfully!', {
        description: `Applied "${preset.name}" configuration.${curatorNames ? ` Popular lists from ${curatorNames} will be added shortly.` : ''} Don't forget to save in the Configuration Manager.`,
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

      {/* Important Disclaimer */}
      <div className="p-4 bg-orange-50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800 rounded-lg">
        <div className="flex items-start space-x-3">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-orange-600 dark:text-orange-400 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-medium text-orange-800 dark:text-orange-200">
              Important: Presets Reset Your Configuration
            </h3>
            <p className="text-sm text-orange-700 dark:text-orange-300 mt-1">
              Applying a preset will <strong>completely reset</strong> your catalog configuration and replace it with the preset's settings. 
              Any custom MDBList catalogs you've added will be removed. Make sure to save your current configuration 
              in the Configuration Manager before applying a preset if you want to preserve your current setup.
            </p>
          </div>
        </div>
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

      {/* Display Type Overrides */}
      <Card>
        <CardContent className="p-4 pt-6 space-y-4">
          <div>
            <Label className="text-lg font-medium">Display Type Overrides</Label>
            <p className="text-sm text-muted-foreground">
              Automatically override catalog display types. For example, display "film" instead of "movie" for all movie catalogs.
            </p>
          </div>

          {/* Movie Override */}
          <div className="space-y-3 pt-2 border-t border-border">
            <div className="flex items-center justify-between">
              <Label htmlFor="override-movie" className="text-sm font-medium">Override "movie" catalogs</Label>
              <Switch
                id="override-movie"
                checked={overrideMovieType}
                onCheckedChange={(checked) => {
                  setOverrideMovieType(checked);
                  handleDisplayTypeOverrides();
                  // Auto-apply when toggling on or off
                  setTimeout(() => applyDisplayTypeOverridesToCatalogs(), 100);
                }}
              />
            </div>
            {overrideMovieType && (
              <div className="space-y-2">
                <Label htmlFor="movie-display-type" className="text-sm">Display as:</Label>
                <Input
                  id="movie-display-type"
                  value={movieDisplayType}
                  onChange={(e) => setMovieDisplayType(e.target.value)}
                  onBlur={handleDisplayTypeOverrides}
                  placeholder="e.g., film, films, película"
                  className="max-w-xs"
                />
                <p className="text-xs text-muted-foreground">
                  All catalogs with type "movie" will display as "{movieDisplayType || 'movie'}"
                </p>
              </div>
            )}
          </div>

          {/* Series Override */}
          <div className="space-y-3 pt-2 border-t border-border">
            <div className="flex items-center justify-between">
              <Label htmlFor="override-series" className="text-sm font-medium">Override "series" catalogs</Label>
              <Switch
                id="override-series"
                checked={overrideSeriesType}
                onCheckedChange={(checked) => {
                  setOverrideSeriesType(checked);
                  handleDisplayTypeOverrides();
                  // Auto-apply when toggling on or off
                  setTimeout(() => applyDisplayTypeOverridesToCatalogs(), 100);
                }}
              />
            </div>
            {overrideSeriesType && (
              <div className="space-y-2">
                <Label htmlFor="series-display-type" className="text-sm">Display as:</Label>
                <Input
                  id="series-display-type"
                  value={seriesDisplayType}
                  onChange={(e) => setSeriesDisplayType(e.target.value)}
                  onBlur={handleDisplayTypeOverrides}
                  placeholder="e.g., shows, tv shows, série"
                  className="max-w-xs"
                />
                <p className="text-xs text-muted-foreground">
                  All catalogs with type "series" will display as "{seriesDisplayType || 'series'}"
                </p>
              </div>
            )}
          </div>

          {/* Apply Button */}
          {(overrideMovieType || overrideSeriesType) && (
            <div className="pt-4 border-t border-border">
              <Button 
                onClick={applyDisplayTypeOverridesToCatalogs}
                className="w-full"
                disabled={
                  (overrideMovieType && !movieDisplayType.trim()) ||
                  (overrideSeriesType && !seriesDisplayType.trim())
                }
              >
                Apply Display Type Overrides to Catalogs
              </Button>
              <p className="text-xs text-muted-foreground mt-2 text-center">
                This will update all your existing catalogs with the configured display types.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Popular Lists Section - Enhanced Visibility */}
      <Card className="border-2 border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/20">
        <CardContent className="p-4 pt-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-start space-x-3">
              <div className="mt-0.5">
                <svg className="w-6 h-6 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <div>
                <Label htmlFor="include-popular-lists" className="text-lg font-semibold text-blue-900 dark:text-blue-100">Include Popular Lists</Label>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  When enabled, automatically imports curated lists from selected MDBList curators when applying presets.
                </p>
              </div>
            </div>
            <Switch 
              id="include-popular-lists"
              checked={includePopularLists} 
              onCheckedChange={setIncludePopularLists}
              className="data-[state=checked]:bg-blue-600"
            />
          </div>

          {/* Curator Selection */}
          {includePopularLists && (
            <div className="space-y-3 pt-4 border-t border-border">
              <Label className="text-sm font-medium">Select Curators to Include:</Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {popularUsers.map((user) => (
                  <div key={user.username} className="flex items-center space-x-3 p-3 border rounded-lg bg-muted/30">
                    <Switch
                      id={`curator-${user.username}`}
                      checked={selectedCurators.has(user.username)}
                      onCheckedChange={(checked) => handleCuratorSelection(user.username, checked)}
                    />
                    <div className="flex-1 min-w-0">
                      <Label htmlFor={`curator-${user.username}`} className="font-medium cursor-pointer">
                        {user.name}
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        {user.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              {selectedCurators.size === 0 && (
                <p className="text-xs text-orange-600 dark:text-orange-400">
                  Please select at least one curator to include popular lists.
                </p>
              )}
              
              {/* Sort selector for curator lists */}
              {selectedCurators.size > 0 && (
                <div className="space-y-2 pt-2">
                  <Label htmlFor="curator-list-sort">Sort Curator Lists By</Label>
                  <Select value={userListSort} onValueChange={(value: 'ranked' | 'name' | 'created') => setUserListSort(value)}>
                    <SelectTrigger id="curator-list-sort" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ranked">Ranked (Default)</SelectItem>
                      <SelectItem value="name">Name</SelectItem>
                      <SelectItem value="created">Date Created</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    This affects how lists are sorted when importing from selected curators
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>


      <div className="grid gap-4 md:grid-cols-2">
        {presetConfigs.map((preset) => {
          const hasPopularLists = includePopularLists && selectedCurators.size > 0;
          const selectedCuratorNames = hasPopularLists 
            ? popularUsers.filter(u => selectedCurators.has(u.username)).map(u => u.name).join(', ')
            : '';
          
          return (
            <Card key={preset.id} className={`relative overflow-hidden ${hasPopularLists ? 'ring-2 ring-blue-200 dark:ring-blue-800' : ''}`}>
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
                  {hasPopularLists && (
                    <div className="flex items-center space-x-1 text-blue-600 dark:text-blue-400">
                      <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      <span className="text-xs font-medium">+ Lists</span>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <CardDescription className="mb-4 text-sm leading-relaxed">
                  {preset.description}
                </CardDescription>
                
                {hasPopularLists && (
                  <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      <strong>Will also import:</strong> Popular lists from {selectedCuratorNames}
                    </p>
                  </div>
                )}
                
                <Button 
                  onClick={() => applyPreset(preset)}
                  className="w-full"
                  variant={hasPopularLists ? "default" : "outline"}
                >
                  {hasPopularLists 
                    ? `Apply Preset + Import Lists` 
                    : 'Apply This Preset'
                  }
                </Button>
              </CardContent>
            </Card>
          );
        })}
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

      {/* MDBList API Key Modal */}
      <MDBListAPIKeyModal
        open={showMDBListModal}
        onOpenChange={(open) => {
          if (!open) {
            handleMDBListAPIKeyCancel();
          }
        }}
        onSubmit={handleMDBListAPIKeySubmit}
        isLoading={isValidatingApiKey}
      />
    </div>
  );
}
