import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { useConfig } from '@/contexts/ConfigContext';
import { AppConfig, CatalogConfig } from '@/contexts/config';
import { allCatalogDefinitions } from '@/data/catalogs';
import { Film, Tv, Sparkles, Users, Wand2, ShieldCheck, Compass, Rocket, PlayCircle, CheckCircle2, Handshake, X } from 'lucide-react';
import { toast } from 'sonner';
import { MDBListAPIKeyModal } from '@/components/MDBListAPIKeyModal';
import { cn } from '@/lib/utils';

interface PresetConfig {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  badge: string;
  badgeColor: string;
  tagline: string;
  highlights: string[];
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
    tagline: 'Classic cinema and TV without anime catalogs.',
    highlights: [
      'Disables all MAL anime catalogs and searches',
      'Keeps TMDB + TVDB metadata for movies and shows',
      'Safe-viewing defaults with SFW enabled'
    ],
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
    name: 'Movies & Shows + Anime (Kitsu)',
    description: 'Best of both worlds - traditional content plus anime with Kitsu as the anime meta provider. Anime poster provider is MAL, background and logo are IMDb.',
    icon: <Sparkles className="h-6 w-6" />,
    badge: 'Hybrid',
    badgeColor: 'bg-purple-500',
    tagline: 'Balanced catalog with anime powered by MAL/Kitsu.',
    highlights: [
      'Adds MAL anime catalogs alongside TMDB/TVDB',
      'Anime metadata from Kitsu with IMDb artwork',
      'Keeps SFW defaults while enabling anime search',
      'Great if you prefer seasons to be displayed as individual entries',
    ],
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
      mal: {
        skipFiller: false,
        skipRecap: false,
        allowEpisodeMarking: false,
        useImdbIdForCatalogAndSearch: false,
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
    tagline: 'Great if you prefer TVDB for anime metadata.',
    highlights: [
      'Anime metadata and catalogs sourced from TVDB',
      'Kitsu compatibility IDs for stream addons',
      'IMDb artwork for anime backgrounds and logos',
      'Great if you prefer TVDB for anime metadata and grouped seasons',
    ],
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
      mal: {
        skipFiller: false,
        skipRecap: false,
        allowEpisodeMarking: false,
        useImdbIdForCatalogAndSearch: false, // Use IMDb ID for Catalog/Search
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
    tagline: 'Optimized for grouped seasons and anime-first libraries.',
    highlights: [
      'Enables grouped MAL catalogs with anime overrides',
      'Anime poster provider switched to TVDB',
      'Anime in non MAL catalogs will be detected as anime and use Anime meta provider',
      'Titles will use an imdb id when possible for better compatibility with apps like Omni/Fusion'
    ],
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
  const [showResetWarning, setShowResetWarning] = useState(true);
  const [lastAppliedPresetId, setLastAppliedPresetId] = useState<string | null>(null);
  
  // MDBList API key modal state
  const [showMDBListModal, setShowMDBListModal] = useState(false);
  const [isValidatingApiKey, setIsValidatingApiKey] = useState(false);
  const mdblistModalResolve = useRef<((apiKey: string) => void) | null>(null);
  const mdblistModalReject = useRef<((error: Error) => void) | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('aiometa_presets_hide_reset_warning');
    if (stored === 'true') {
      setShowResetWarning(false);
    }
  }, []);

  const quickStartSteps = useMemo(() => [
    {
      title: 'Choose a preset',
      description: 'Pick the vibe that matches your library—movies only, hybrid, or anime-first.',
      icon: <Compass className="h-5 w-5" />
    },
    {
      title: 'Personalize it',
      description: 'Tweak safety filters, wording, and optional curated lists with a few toggles.',
      icon: <Wand2 className="h-5 w-5" />
    },
    {
      title: 'Save & explore',
      description: 'Apply the preset, then fine-tune or duplicate it from the Configuration tab.',
      icon: <Rocket className="h-5 w-5" />
    }
  ], []);

  const handleExploreGuide = () => {
    if (typeof window === 'undefined') return;
    window.open('https://www.youtube.com/watch?v=AOxfOflZAsA', '_blank', 'noopener,noreferrer');
  };

  const handleDismissWarning = () => {
    setShowResetWarning(false);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('aiometa_presets_hide_reset_warning', 'true');
    }
  };

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
          const response = await fetch(`/api/mdblist/lists/user?apikey=${apiKey}&username=${user.username}&sort=${userListSort}`);
          
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
            
            // Construct list URL from username and list name
            const username = (list.user_name || list.user || '').toLowerCase().replace(/\s+/g, '');
            const listSlug = list.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            const listUrl = username && listSlug ? `https://mdblist.com/lists/${username}/${listSlug}` : undefined;
            
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
              enableRatingPosters: true,
              displayType,
              metadata: {
                ...(list.items !== undefined && { itemCount: list.items }),
                ...(list.user_name || list.user ? { author: list.user_name || list.user } : {}),
                ...(listUrl && { url: listUrl }),
              },
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
    setLastAppliedPresetId(preset.id);
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
    <div className="space-y-8 animate-fade-in">
      {/* Hero */}
      <Card className="overflow-hidden border border-primary/10 bg-gradient-to-br from-primary/5 via-background to-background">
        <CardContent className="p-6 md:p-8 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
          <div className="space-y-3 max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
              <Sparkles className="h-4 w-4" />
              Welcome to Presets
            </div>
            <h2 className="text-3xl font-semibold tracking-tight">Start with a curated setup in one click.</h2>
            <p className="text-base text-muted-foreground">
              Presets bundle catalog, metadata, and safety preferences so you can get a tailored experience instantly. Personalize the details, save what you love, and explore further as you go. For adequate/optimal user experience in Stremio, please use{' '}
              <a
                href="https://cinebye.dinsden.top/"
                target="_blank"
                rel="noopener noreferrer"
                className="group relative inline-flex items-center gap-1 text-primary underline underline-offset-4 transition"
              >
                <span className="animate-pulse [animation-duration:2s]">Cinebye</span>
                <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-primary/80 transition-transform duration-300 group-hover:scale-x-100" aria-hidden="true" />
              </a>{' '}
              to deactivate the meta functionality from Cinemeta. A visual guide on how to do set up and more below.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleExploreGuide} className="gap-2">
                <PlayCircle className="h-4 w-4" />
                Watch the Elfhosted guide
              </Button>
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <ShieldCheck className="h-4 w-4" />
                Presets can be adjusted or duplicated anytime.
              </span>
      </div>
          </div>
          <div className="hidden md:block rounded-xl border border-primary/20 bg-primary/5 px-6 py-5 text-sm text-primary shadow-inner">
            <p className="font-semibold mb-2">Need inspiration?</p>
            <p className="text-primary/80">
              Try “Anime Lovers” to unlock grouped seasons and curated lists, or select “Movies & Shows Only” for a classic streaming experience.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Quick start */}
      <div className="grid gap-4 md:grid-cols-3">
        {quickStartSteps.map(step => (
          <div key={step.title} className="rounded-xl border border-border bg-muted/40 p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border">
                {step.icon}
          </div>
              <div className="space-y-1">
                <p className="font-medium leading-tight">{step.title}</p>
                <p className="text-sm text-muted-foreground">{step.description}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Reset warning */}
      {showResetWarning && (
        <div className="relative rounded-xl border border-amber-300/60 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-900/30 dark:text-amber-100">
          <button
            onClick={handleDismissWarning}
            className="absolute right-3 top-3 text-amber-700/80 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
            aria-label="Dismiss preset warning"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex flex-col gap-2 p-4 md:p-5 md:flex-row md:items-start md:gap-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-300" />
            <div className="space-y-1">
              <p className="text-sm font-semibold">Heads up: applying a preset replaces your current catalogs.</p>
              <p className="text-sm text-amber-800/90 dark:text-amber-200">
                We recommend saving your existing configuration first. You can always duplicate a preset or tweak it afterwards.
              </p>
              <div className="flex flex-wrap gap-2 text-sm">
                <Button variant="link" className="px-0 text-amber-700 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100" onClick={() => handleExploreGuide()}>
                  Learn how to back up my setup
                </Button>
          </div>
        </div>
      </div>
        </div>
      )}

      {/* Personalization controls */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle>Personalize before applying</CardTitle>
          <CardDescription>
            Adjust safety, wording, or curated lists. These settings apply no matter which preset you choose.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Accordion type="multiple" defaultValue={['safety', 'labels']}>
            <AccordionItem value="safety" className="border-b border-border/60 px-4">
              <AccordionTrigger className="py-4 text-left">Safe viewing preferences</AccordionTrigger>
              <AccordionContent className="pb-6">
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="include-adult" className="text-base font-medium">Include adult content</Label>
                    <p className="text-sm text-muted-foreground max-w-xl">
                      Toggle this on if you want unrestricted metadata and catalog results. We’ll keep SFW filters on otherwise.
            </p>
          </div>
          <Switch 
            id="include-adult"
            checked={includeAdult} 
            onCheckedChange={handleAdultContentToggle} 
          />
          </div>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="labels" className="border-b border-border/60 px-4">
              <AccordionTrigger className="py-4 text-left">Override catalog types display</AccordionTrigger>
              <AccordionContent className="pb-6 space-y-5">
                <div className="rounded-lg border border-border/50 bg-muted/40 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <Label htmlFor="override-movie" className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Movies</Label>
                      <p className="text-sm text-muted-foreground">Prefer “film” or “feature” instead of “movie”? Update it here.</p>
                    </div>
              <Switch
                id="override-movie"
                checked={overrideMovieType}
                onCheckedChange={(checked) => {
                  setOverrideMovieType(checked);
                  handleDisplayTypeOverrides();
                  setTimeout(() => applyDisplayTypeOverridesToCatalogs(), 100);
                }}
              />
            </div>
            {overrideMovieType && (
                    <div className="mt-3 space-y-2">
                <Input
                  id="movie-display-type"
                  value={movieDisplayType}
                  onChange={(e) => setMovieDisplayType(e.target.value)}
                  onBlur={handleDisplayTypeOverrides}
                        placeholder='e.g., film, films, película'
                        className="max-w-sm"
                />
                      <p className="text-xs text-muted-foreground">Current catalogs will show as “{movieDisplayType || 'movie'}”.</p>
              </div>
            )}
          </div>
                <div className="rounded-lg border border-border/50 bg-muted/40 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <Label htmlFor="override-series" className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Series</Label>
                      <p className="text-sm text-muted-foreground">Rename every “series” catalog to match your taste (e.g., shows, dramas).</p>
                    </div>
              <Switch
                id="override-series"
                checked={overrideSeriesType}
                onCheckedChange={(checked) => {
                  setOverrideSeriesType(checked);
                  handleDisplayTypeOverrides();
                  setTimeout(() => applyDisplayTypeOverridesToCatalogs(), 100);
                }}
              />
            </div>
            {overrideSeriesType && (
                    <div className="mt-3 space-y-2">
                <Input
                  id="series-display-type"
                  value={seriesDisplayType}
                  onChange={(e) => setSeriesDisplayType(e.target.value)}
                  onBlur={handleDisplayTypeOverrides}
                        placeholder='e.g., shows, tv shows, série'
                        className="max-w-sm"
                />
                      <p className="text-xs text-muted-foreground">Current catalogs will show as “{seriesDisplayType || 'series'}”.</p>
              </div>
            )}
          </div>
          {(overrideMovieType || overrideSeriesType) && (
                  <div className="flex flex-col gap-2 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/30 p-4 text-center">
                    <p className="text-sm text-muted-foreground">
                      Ready to update your catalog list with these labels?
                    </p>
              <Button 
                onClick={applyDisplayTypeOverridesToCatalogs}
                      className="mx-auto w-full sm:w-auto"
                disabled={
                  (overrideMovieType && !movieDisplayType.trim()) ||
                  (overrideSeriesType && !seriesDisplayType.trim())
                }
              >
                      Apply label changes now
              </Button>
            </div>
          )}
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="curators" className="px-4">
              <AccordionTrigger className="py-4 text-left">Add curated MDBList collections</AccordionTrigger>
              <AccordionContent className="pb-6 space-y-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-1">
                    <Label htmlFor="include-popular-lists" className="text-base font-medium">Import trusted curators</Label>
                    <p className="text-sm text-muted-foreground max-w-xl">
                      Auto-import curated MDBList collections when you apply a preset. Great for keeping your library fresh.
                    </p>
            </div>
            <Switch 
              id="include-popular-lists"
              checked={includePopularLists} 
              onCheckedChange={setIncludePopularLists}
              className="data-[state=checked]:bg-blue-600"
            />
          </div>
          {includePopularLists && (
                  <div className="space-y-4 rounded-lg border border-blue-200/70 bg-blue-50/40 p-4 dark:border-blue-900/40 dark:bg-blue-950/20">
                    <div className="grid gap-3 sm:grid-cols-2">
                {popularUsers.map((user) => (
                        <label
                          key={user.username}
                          htmlFor={`curator-${user.username}`}
                          className={cn(
                            'flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 bg-background/60 p-3 transition hover:border-primary/40 hover:bg-background',
                            selectedCurators.has(user.username) && 'border-primary/60 shadow-sm'
                          )}
                        >
                          <input
                      id={`curator-${user.username}`}
                            type="checkbox"
                      checked={selectedCurators.has(user.username)}
                            onChange={(event) => handleCuratorSelection(user.username, event.target.checked)}
                            className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                          />
                          <div className="space-y-1">
                            <p className="font-medium leading-tight">{user.name}</p>
                            <p className="text-xs text-muted-foreground">{user.description}</p>
                    </div>
                        </label>
                ))}
              </div>
              {selectedCurators.size === 0 && (
                      <div className="rounded-md bg-amber-100/80 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-100">
                        Select at least one curator to include their lists.
                      </div>
                    )}
              {selectedCurators.size > 0 && (
                      <div className="space-y-2">
                        <Label htmlFor="curator-list-sort" className="text-sm font-medium">Sort imported lists by</Label>
                  <Select value={userListSort} onValueChange={(value: 'ranked' | 'name' | 'created') => setUserListSort(value)}>
                          <SelectTrigger id="curator-list-sort" className="w-full sm:w-64">
                            <SelectValue placeholder="Choose sort order" />
                    </SelectTrigger>
                    <SelectContent>
                            <SelectItem value="ranked">Ranked (default)</SelectItem>
                      <SelectItem value="name">Name</SelectItem>
                            <SelectItem value="created">Date created</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                          Lists import automatically right after you apply a preset.
                  </p>
                </div>
              )}
            </div>
          )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      </Card>

      {/* Preset grid */}
      <div className="grid gap-5 lg:grid-cols-2">
        {presetConfigs.map((preset) => {
          const hasPopularLists = includePopularLists && selectedCurators.size > 0;
          const selectedCuratorNames = hasPopularLists 
            ? popularUsers.filter(u => selectedCurators.has(u.username)).map(u => u.name).join(', ')
            : '';
          const isActive = lastAppliedPresetId === preset.id;
          
          return (
            <Card
              key={preset.id}
              className={cn(
                'relative overflow-hidden border transition hover:shadow-lg',
                isActive ? 'ring-2 ring-emerald-400/70' : ''
              )}
            >
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/40 via-transparent to-transparent" />
              <CardHeader className="relative flex flex-col gap-2 pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-1 min-w-0 items-start gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted">
                      {preset.icon}
                    </div>
                    <div className="space-y-1">
                      <CardTitle className="text-lg break-words">{preset.name}</CardTitle>
                      <p className="text-sm text-muted-foreground">{preset.tagline}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <Badge className={cn('text-white', preset.badgeColor)}>{preset.badge}</Badge>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Applied
                      </span>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="relative space-y-4 pt-0">
                <ul className="space-y-2 text-sm">
                  {preset.highlights.map((highlight) => (
                    <li key={highlight} className="flex items-start gap-3 text-muted-foreground">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 text-primary flex-shrink-0" />
                      <span>{highlight}</span>
                    </li>
                  ))}
                </ul>
                {hasPopularLists && (
                  <div className="rounded-lg border border-blue-200/60 bg-blue-50/60 px-3 py-2 text-xs text-blue-700 dark:border-blue-900/40 dark:bg-blue-950/20 dark:text-blue-200">
                    Will also import curated lists from {selectedCuratorNames}.
                  </div>
                )}
                <Button 
                  onClick={() => applyPreset(preset)}
                  className="w-full"
                  variant={isActive ? 'secondary' : hasPopularLists ? 'default' : 'outline'}
                >
                  {hasPopularLists ? 'Apply preset & import lists' : 'Apply this preset'}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* About & help */}
      <Card className="border-dashed border-border bg-muted/30">
        <CardHeader>
          <CardTitle className="text-lg">What each preset configures</CardTitle>
          <CardDescription>Behind the scenes we tune metadata providers, art sources, catalogs, and search engines to match the style you choose.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/50 p-4">
              <Wand2 className="mt-0.5 h-5 w-5 text-primary" />
              <div className="space-y-1 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Meta & artwork</p>
                <p>Switches between TMDB, TVDB, MAL, and Kitsu with matching artwork fallbacks.</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/50 p-4">
              <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" />
              <div className="space-y-1 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Catalog lineup</p>
                <p>Enables or disables curated catalog sets (anime, trending, classic movie collections).</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/50 p-4">
              <Compass className="mt-0.5 h-5 w-5 text-primary" />
              <div className="space-y-1 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Search experience</p>
                <p>Adjusts which providers power movie, series, and anime search results.</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/50 p-4">
              <Users className="mt-0.5 h-5 w-5 text-primary" />
              <div className="space-y-1 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">Optional community lists</p>
                <p>Import MDBList curators you trust, then manage them from the Catalogs tab.</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

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
