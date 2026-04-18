import React, { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useConfig } from '@/contexts/ConfigContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Edit2, GripVertical, Star, Sparkles, AlertTriangle } from 'lucide-react';
import { allSearchProviders } from '@/data/catalogs';
import { GEMINI_MODELS, DEFAULT_GEMINI_MODEL, DEFAULT_OPENROUTER_MODEL } from '@/data/ai-models';
import type { AIModel } from '@/data/ai-models';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const DEFAULT_SEARCH_ORDER = [
  'movie',
  'series',
  'tvdb.collections.search',
  'gemini.search',
  'anime_series',
  'anime_movie',
  'people_search_movie',
  'people_search_series',
];

// Sortable Search Provider Item Component
function SortableSearchProviderItem({ provider, onEditSearchName, onEngineEnabledChange, onengineRatingPostersChange, getSearchDisplayName, getProviderBaseLabel, getSearchCustomName, getSearchDisplayType, hasRPDBKey, engineRatingPostersEnabled }: {
  provider: { id: string; type: string; provider: string };
  onEditSearchName: (searchId: string) => void;
  onEngineEnabledChange: (engine: string, checked: boolean) => void;
  onengineRatingPostersChange: (engine: string, checked: boolean) => void;
  getSearchDisplayName: (searchId: string, providerId: string) => string;
  getProviderBaseLabel: (providerId: string) => string;
  getSearchCustomName: (searchId: string) => string;
  getSearchDisplayType: (searchId: string) => string;
  hasRPDBKey: boolean;
  engineRatingPostersEnabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: provider.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 'auto',
  };

  const searchName = getSearchDisplayName(provider.id, provider.provider);
  const providerLabel = getProviderBaseLabel(provider.provider);
  const displayType = getSearchDisplayType(provider.id);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 p-3 border border-border rounded-lg bg-background ${
        isDragging ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <div
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab active:cursor-grabbing p-1 hover:bg-accent rounded touch-none"
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0 text-sm">
          <div className="font-medium break-words sm:truncate">
            {searchName}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <span className="truncate">{providerLabel}</span>
            <span className="text-muted-foreground/60 shrink-0">•</span>
            <span className="capitalize truncate">{displayType}</span>
          </div>
        </div>
        <Switch
          className="shrink-0 sm:hidden"
          checked={true}
          onCheckedChange={checked => onEngineEnabledChange(provider.provider, checked)}
          aria-label="Enable this engine"
        />
      </div>
      <div className="flex items-center gap-2 sm:gap-3 justify-end sm:ml-auto">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onEditSearchName(provider.id)}
          className="shrink-0 px-2"
        >
          <Edit2 className="h-4 w-4" />
        </Button>
        {hasRPDBKey && provider.provider !== 'tvdb.collections.search' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onengineRatingPostersChange(provider.id, !engineRatingPostersEnabled)}
            className="shrink-0 px-2"
            title={engineRatingPostersEnabled ? 'Rating posters enabled' : 'Rating posters disabled'}
          >
            <Star className={`h-4 w-4 ${engineRatingPostersEnabled ? 'text-yellow-500 dark:text-yellow-400' : 'text-muted-foreground'}`} />
          </Button>
        )}
        <Switch
          className="shrink-0 hidden sm:inline-flex"
          checked={true}
          onCheckedChange={checked => onEngineEnabledChange(provider.provider, checked)}
          aria-label="Enable this engine"
        />
      </div>
    </div>
  );
}

export function SearchSettings() {
  const { config, setConfig, hasBuiltInTvdb, traktSearchEnabled } = useConfig();
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('');
  const hasGeminiKey = !!config.apiKeys?.gemini;
  const hasOpenRouterKey = !!config.apiKeys?.openrouter;
  const hasAnyAiKey = hasGeminiKey || hasOpenRouterKey;
  const [openRouterModels, setOpenRouterModels] = useState<AIModel[]>([]);
  const [openRouterModelsLoading, setOpenRouterModelsLoading] = useState(false);
  const openRouterKeyRef = React.useRef(config.apiKeys?.openrouter);

  // Fetch OpenRouter model list when key is available
  useEffect(() => {
    const key = config.apiKeys?.openrouter;
    if (!key || key === openRouterKeyRef.current && openRouterModels.length > 0) {
      if (!key) setOpenRouterModels([]);
      openRouterKeyRef.current = key;
      return;
    }
    openRouterKeyRef.current = key;
    let cancelled = false;
    setOpenRouterModelsLoading(true);
    fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
    })
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        const models: AIModel[] = (data?.data || [])
          .filter((m: any) => m.id && m.name)
          .map((m: any) => ({ id: m.id, name: m.name, grounding: false }))
          .sort((a: AIModel, b: AIModel) => a.name.localeCompare(b.name));
        setOpenRouterModels(models);
      })
      .catch(() => { if (!cancelled) setOpenRouterModels([]); })
      .finally(() => { if (!cancelled) setOpenRouterModelsLoading(false); });
    return () => { cancelled = true; };
  }, [config.apiKeys?.openrouter]); // eslint-disable-line react-hooks/exhaustive-deps

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Get enabled search providers in order
  const getEnabledSearchProviders = () => {
    const rawSearchOrder = Array.isArray(config.search.searchOrder) ? config.search.searchOrder : [];
    const searchOrder = Array.from(new Set([...rawSearchOrder, ...DEFAULT_SEARCH_ORDER]));
    const enabledProviders = [];
    
    // Add movie search if enabled
    if (config.search.engineEnabled?.[config.search.providers.movie] !== false) {
      enabledProviders.push({ id: 'movie', type: 'movie', provider: config.search.providers.movie });
    }
    
    // Add series search if enabled
    if (config.search.engineEnabled?.[config.search.providers.series] !== false) {
      enabledProviders.push({ id: 'series', type: 'series', provider: config.search.providers.series });
    }
    
    // Add TVDB collections if enabled
    if (config.search.engineEnabled?.['tvdb.collections.search'] !== false && hasTvdbKey) {
      enabledProviders.push({ id: 'tvdb.collections.search', type: 'collection', provider: 'tvdb.collections.search' });
    }
    // Add Gemini AI search if enabled (AI or explicit engine enable and key present)
    if (config.search.engineEnabled?.['gemini.search'] !== false && config.search.ai_enabled && hasAnyAiKey) {
      enabledProviders.push({ id: 'gemini.search', type: 'ai', provider: 'gemini.search' });
    }
    
    // Add anime series search if enabled
    if (config.search.engineEnabled?.[config.search.providers.anime_series] !== false) {
      enabledProviders.push({ id: 'anime_series', type: 'anime.series', provider: config.search.providers.anime_series });
    }
    
    // Add anime movie search if enabled
    if (config.search.engineEnabled?.[config.search.providers.anime_movie] !== false) {
      enabledProviders.push({ id: 'anime_movie', type: 'anime.movie', provider: config.search.providers.anime_movie });
    }
    
    const peopleSearchMovieProvider = config.search.providers.people_search_movie || 'tmdb.people.search';
    if (config.search.engineEnabled?.['people_search_movie'] !== false) {
      enabledProviders.push({ id: 'people_search_movie', type: 'movie', provider: peopleSearchMovieProvider });
    }
    
    const peopleSearchSeriesProvider = config.search.providers.people_search_series || 'tmdb.people.search';
    if (config.search.engineEnabled?.['people_search_series'] !== false) {
      enabledProviders.push({ id: 'people_search_series', type: 'series', provider: peopleSearchSeriesProvider });
    }
    
    // Sort by the searchOrder array
    return enabledProviders.sort((a, b) => {
      const aIndex = searchOrder.indexOf(a.id);
      const bIndex = searchOrder.indexOf(b.id);
      const aPos = aIndex === -1 ? Number.POSITIVE_INFINITY : aIndex;
      const bPos = bIndex === -1 ? Number.POSITIVE_INFINITY : bIndex;
      return aPos - bPos;
    });
  };

  const handleDragEnd = (event: any) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    
    const enabledProviders = getEnabledSearchProviders();
    const oldIndex = enabledProviders.findIndex(item => item.id === active.id);
    const newIndex = enabledProviders.findIndex(item => item.id === over.id);
    
    if (oldIndex !== -1 && newIndex !== -1) {
      const reorderedProviders = arrayMove(enabledProviders, oldIndex, newIndex);
      const reorderedEnabledIds = reorderedProviders.map(item => item.id);
      const currentOrder = Array.isArray(config.search.searchOrder) ? config.search.searchOrder : [];
      const normalizedCurrentOrder = Array.from(new Set([...currentOrder, ...DEFAULT_SEARCH_ORDER]));
      const remainingIds = normalizedCurrentOrder.filter(id => !reorderedEnabledIds.includes(id));
      const newSearchOrder = [...reorderedEnabledIds, ...remainingIds];
      
      setConfig(prev => ({
        ...prev,
        search: {
          ...prev.search,
          searchOrder: newSearchOrder
        }
      }));
    }
  };

  // Helper function to get display name for a provider
  const getProviderBaseLabel = (providerId: string) => {
    if (providerId === 'tvdb.collections.search') {
      return 'TVDB Collections';
    }
    if (providerId === 'gemini.search') {
      return 'AI Search';
    }

    const provider = allSearchProviders.find(p => p.value === providerId);
    return provider?.label || providerId;
  };

  // Helper function to get default search name
  const getDefaultSearchName = (searchId: string) => {
    const searchNameMap: { [key: string]: string } = {
      'movie': 'Movies Search',
      'series': 'Series Search',
      'anime_series': 'Anime Series Search',
      'anime_movie': 'Anime Movies Search',
      'tvdb.collections.search': 'TVDB Collections',
      'gemini.search': 'AI Search',
      'people_search_movie': 'People Search (Movies)',
      'people_search_series': 'People Search (Series)',
    };
    return searchNameMap[searchId] || searchId;
  };

  const getSearchCustomName = (searchId: string) =>
    config.search.searchNames?.[searchId]?.trim() || '';

  const getSearchDisplayName = (searchId: string, providerId: string) => {
    const customName = getSearchCustomName(searchId);
    if (customName) {
      return customName;
    }
    return getDefaultSearchName(searchId);
  };

  // Helper function to get default type for a search catalog
  const getDefaultSearchType = (searchId: string) => {
    const searchTypeMap: { [key: string]: string } = {
      'movie': 'movie',
      'series': 'series',
      'anime_series': 'anime.series',
      'anime_movie': 'anime.movie',
      'tvdb.collections.search': 'collection',
      'gemini.search': 'other',
      'people_search_movie': 'movie',
      'people_search_series': 'series',
    };
    return searchTypeMap[searchId] || 'movie';
  };

  const getSearchCustomType = (searchId: string) =>
    config.search.searchDisplayTypes?.[searchId]?.trim() || '';

  const getSearchDisplayType = (searchId: string) => {
    const customType = getSearchCustomType(searchId);
    if (customType) {
      return customType;
    }
    return getDefaultSearchType(searchId);
  };

  const handleEditSearchName = (searchId: string) => {
    setEditingProvider(searchId);
    setEditName(getSearchCustomName(searchId) || getDefaultSearchName(searchId));
    setEditType(getSearchCustomType(searchId) || getDefaultSearchType(searchId));
  };

  const handleSaveSearchName = () => {
    if (editingProvider && editName.trim() && editType.trim()) {
      setConfig(prev => ({
        ...prev,
        search: {
          ...prev.search,
          searchNames: {
            ...prev.search.searchNames,
            [editingProvider]: editName.trim()
          },
          searchDisplayTypes: {
            ...prev.search.searchDisplayTypes,
            [editingProvider]: editType.trim()
          }
        }
      }));
    }
    setEditingProvider(null);
    setEditName('');
    setEditType('');
  };

  const handleCancelEdit = () => {
    setEditingProvider(null);
    setEditName('');
    setEditType('');
  };

  // Legacy function for backward compatibility with Primary Keyword Engines section
  const getProviderDisplayName = (providerId: string) => {
    const baseLabel = getProviderBaseLabel(providerId);
    return baseLabel;
  };

  const handleSearchEnabledChange = (checked: boolean) => {
    setConfig(prev => ({ ...prev, search: { ...prev.search, enabled: checked } }));
  };

  const handleAiToggle = (checked: boolean) => {
    setConfig(prev => ({
      ...prev,
      search: {
        ...prev.search,
        ai_enabled: checked,
        // Set default provider/model if not already set
        ai_provider: prev.search.ai_provider || 'gemini',
        ai_model: prev.search.ai_model || DEFAULT_GEMINI_MODEL,
        engineEnabled: {
          ...prev.search.engineEnabled,
          'gemini.search': checked,
        },
        searchOrder: (() => {
          const currentOrder = Array.isArray(prev.search.searchOrder) ? prev.search.searchOrder : [];
          return Array.from(new Set([...currentOrder, ...DEFAULT_SEARCH_ORDER]));
        })(),
      },
    }));
  };

  const handleAiProviderChange = (provider: 'gemini' | 'openrouter') => {
    const defaultModel = provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_GEMINI_MODEL;
    setConfig(prev => ({
      ...prev,
      search: {
        ...prev.search,
        ai_provider: provider,
        ai_model: defaultModel,
      },
    }));
  };

  const handleAiModelChange = (model: string) => {
    setConfig(prev => ({
      ...prev,
      search: {
        ...prev.search,
        ai_model: model,
      },
    }));
  };

  const handleProviderChange = (
    type: 'movie' | 'series' | 'anime_movie' | 'anime_series' | 'people_search_movie' | 'people_search_series', 
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
        ...(engine === 'gemini.search' && { ai_enabled: checked }),
      },
    }));
  };

  const handleengineRatingPostersChange = (engine: string, checked: boolean) => {
    setConfig(prev => ({
      ...prev,
      search: {
        ...prev.search,
        engineRatingPosters: {
          ...prev.search.engineRatingPosters,
          [engine]: checked,
        },
      },
    }));
  };

  // Check if TVDB key and rating poster keys are available
  const hasTvdbKey = !!config.apiKeys?.tvdb?.trim() || hasBuiltInTvdb;
  const hasRPDBKey = !!config.apiKeys?.rpdb || !!config.apiKeys?.topPoster || !!config.customPosterUrlPattern;
  const isTraktSearchEnabled = traktSearchEnabled;
  const movieSearchProviders = allSearchProviders.filter(p => {
    if ((p.value === 'trakt.search' || p.value === 'trakt.people.search') && !isTraktSearchEnabled) {
      return false;
    }
    return p.mediaType.includes('movie') &&
           !p.value.includes('people.search') &&
           p.value !== 'mal.search.movie' &&
           p.value !== 'kitsu.search.movie';
  });
  
  const seriesSearchProviders = allSearchProviders.filter(p => {
    if ((p.value === 'trakt.search' || p.value === 'trakt.people.search') && !isTraktSearchEnabled) {
      return false;
    }
    return p.mediaType.includes('series') && 
           !p.value.includes('people.search') &&
           p.value !== 'mal.search.series' &&
           p.value !== 'kitsu.search.series';
  });
  
  const animeSearchProviders = allSearchProviders.filter(
    p => p.mediaType.includes('anime_movie') || p.mediaType.includes('anime_series')
  );
  
  const peopleSearchProviders = allSearchProviders.filter(
    p => {
      if (p.value === 'trakt.people.search' && !isTraktSearchEnabled) {
        return false;
      }
      return p.value.includes('people.search')
    }
  );

  useEffect(() => {
    if (!traktSearchEnabled) {
      const updates: Partial<Record<string, string>> = {};
      if (config.search.providers.movie === 'trakt.search') updates.movie = 'tmdb.search';
      if (config.search.providers.series === 'trakt.search') updates.series = 'tvdb.search';
      if (config.search.providers.people_search_movie === 'trakt.people.search') updates.people_search_movie = 'tmdb.people.search';
      if (config.search.providers.people_search_series === 'trakt.people.search') updates.people_search_series = 'tmdb.people.search';

      if (Object.keys(updates).length > 0) {
        setConfig(prev => ({
          ...prev,
          search: {
            ...prev.search,
            providers: {
              ...prev.search.providers,
              ...updates,
            },
          },
        }));
      }
    }
  }, [traktSearchEnabled]);

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Search Settings</h2>
        <p className="text-muted-foreground mt-1">Configure your addon's search functionality.</p>
      </div>

      <Card>
        <CardContent className="p-4 pt-6 flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
                <Label htmlFor="search-enabled" className="text-base sm:text-lg font-medium">Enable Search functionality</Label>
            </div>
            <Switch
              id="search-enabled"
              className="shrink-0"
              checked={config.search.enabled}
              onCheckedChange={handleSearchEnabledChange}
            />
        </CardContent>
      </Card>
      
      {config.search.enabled && (
        <div className="space-y-8 pl-4 sm:pl-6 border-l-2 border-border">
            <Card>
                <CardHeader>
                    <CardTitle>Primary Keyword Engines</CardTitle>
                    <CardDescription>
                        Choose the default engine for basic keyword searches. The AI search uses this engine to find items based on its suggestions.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                        <Label className="text-lg font-medium">Movies Search Engine:</Label>
                        <div className="flex items-center gap-3 w-full sm:w-[280px]">
                            <Select value={config.search.providers.movie} onValueChange={(val) => handleProviderChange('movie', val)}>
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {movieSearchProviders.map(p => (
                                      <SelectItem
                                        key={p.value}
                                        value={p.value}
                                        disabled={p.value === 'tvdb.search' && !hasTvdbKey}
                                      >
                                        {getProviderDisplayName(p.value)}
                                        {p.value === 'tvdb.search' && !hasTvdbKey && ' (API key required)'}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Switch
                                checked={config.search.engineEnabled?.[config.search.providers.movie] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange(config.search.providers.movie, checked)}
                                aria-label="Enable this engine"
                            />
                        </div>
                    </div>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                        <Label className="text-lg font-medium">Series Search Engine:</Label>
                        <div className="flex items-center gap-3 w-full sm:w-[280px]">
                            <Select value={config.search.providers.series} onValueChange={(val) => handleProviderChange('series', val)}>
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {seriesSearchProviders.map(p => (
                                      <SelectItem
                                        key={p.value}
                                        value={p.value}
                                        disabled={p.value === 'tvdb.search' && !hasTvdbKey}
                                      >
                                        {getProviderDisplayName(p.value)}
                                        {p.value === 'tvdb.search' && !hasTvdbKey && ' (API key required)'}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Switch
                                checked={config.search.engineEnabled?.[config.search.providers.series] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange(config.search.providers.series, checked)}
                                aria-label="Enable this engine"
                            />
                        </div>
                    </div>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                        <Label className="text-lg font-medium">Anime (Series) Search Engine:</Label>
                        <div className="flex items-center gap-3 w-full sm:w-[280px]">
                            <Select value={config.search.providers.anime_series} onValueChange={(val) => handleProviderChange('anime_series', val)}>
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {animeSearchProviders
                                      .filter(p => p.mediaType.includes('anime_series'))
                                      .map(p => (
                                        <SelectItem key={p.value} value={p.value}>
                                          {getProviderDisplayName(p.value)}
                                        </SelectItem>
                                      ))}
                                </SelectContent>
                            </Select>
                            <Switch
                                checked={config.search.engineEnabled?.[config.search.providers.anime_series] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange(config.search.providers.anime_series, checked)}
                                aria-label="Enable this engine"
                            />
                        </div>
                    </div>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                        <Label className="text-lg font-medium">Anime (Movies) Search Engine:</Label>
                        <div className="flex items-center gap-3 w-full sm:w-[280px]">
                            <Select value={config.search.providers.anime_movie} onValueChange={(val) => handleProviderChange('anime_movie', val)}>
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {animeSearchProviders
                                      .filter(p => p.mediaType.includes('anime_movie'))
                                      .map(p => (
                                        <SelectItem key={p.value} value={p.value}>
                                          {getProviderDisplayName(p.value)}
                                        </SelectItem>
                                      ))}
                                </SelectContent>
                            </Select>
                            <Switch
                                checked={config.search.engineEnabled?.[config.search.providers.anime_movie] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange(config.search.providers.anime_movie, checked)}
                                aria-label="Enable this engine"
                            />
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* People Search */}
            <Card>
                <CardHeader>
                    <CardTitle>People Search</CardTitle>
                    <CardDescription>
                        Search for movies and series by person names (actors, directors, writers). Only searches people's credits, not titles.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                        <Label className="text-lg font-medium">People Search (Movies) Engine:</Label>
                        <div className="flex items-center gap-3 w-full sm:w-[280px]">
                            <Select
                                value={config.search.providers.people_search_movie || 'tmdb.people.search'}
                                onValueChange={(val) => handleProviderChange('people_search_movie', val)}
                            >
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {peopleSearchProviders
                                      .filter(p => p.mediaType.includes('movie'))
                                      .map(p => (
                                        <SelectItem
                                          key={p.value}
                                          value={p.value}
                                          disabled={p.value === 'tvdb.people.search' && !hasTvdbKey}
                                        >
                                          {getProviderDisplayName(p.value)}
                                          {p.value === 'tvdb.people.search' && !hasTvdbKey && ' (API key required)'}
                                        </SelectItem>
                                      ))}
                                </SelectContent>
                            </Select>
                            <Switch
                                checked={config.search.engineEnabled?.['people_search_movie'] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange('people_search_movie', checked)}
                                aria-label="Enable people search for movies"
                            />
                        </div>
                    </div>
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                        <Label className="text-lg font-medium">People Search (Series) Engine:</Label>
                        <div className="flex items-center gap-3 w-full sm:w-[280px]">
                            <Select
                                value={config.search.providers.people_search_series || 'tmdb.people.search'}
                                onValueChange={(val) => handleProviderChange('people_search_series', val)}
                            >
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    {peopleSearchProviders
                                      .filter(p => p.mediaType.includes('series'))
                                      .map(p => (
                                        <SelectItem
                                          key={p.value}
                                          value={p.value}
                                          disabled={p.value === 'tvdb.people.search' && !hasTvdbKey}
                                        >
                                          {getProviderDisplayName(p.value)}
                                          {p.value === 'tvdb.people.search' && !hasTvdbKey && ' (API key required)'}
                                        </SelectItem>
                                      ))}
                                </SelectContent>
                            </Select>
                            <Switch
                                checked={config.search.engineEnabled?.['people_search_series'] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange('people_search_series', checked)}
                                aria-label="Enable people search for series"
                            />
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* TVDB Collections Search - only show if TVDB key is available */}
            {hasTvdbKey && (
                <Card>
                    <CardHeader>
                        <CardTitle>TVDB Collections Search</CardTitle>
                        <CardDescription>Search for curated TVDB lists and collections</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between space-y-2 sm:space-y-0">
                            <Label className="text-lg font-medium">Enable TVDB Collections Search:</Label>
                            <Switch
                                checked={config.search.engineEnabled?.['tvdb.collections.search'] ?? false}
                                onCheckedChange={checked => handleEngineEnabledChange('tvdb.collections.search', checked)}
                                aria-label="Enable TVDB Collections search"
                            />
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* AI Search Toggle */}
            <Card>
                <CardHeader>
                    <div className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-primary" />
                        <CardTitle>AI-Powered Search</CardTitle>
                    </div>
                    <CardDescription>
                        Use AI to interpret natural language queries and find media using descriptive phrases instead of exact titles.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex-1 min-w-0">
                            {!hasAnyAiKey && (
                                <p className="text-sm text-muted-foreground">
                                    A Gemini or OpenRouter API key is required to enable AI search. Add your key in the Integrations settings.
                                </p>
                            )}
                        </div>
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <div className="shrink-0">
                                        <Switch
                                            id="ai-search-enabled"
                                            checked={config.search.ai_enabled}
                                            onCheckedChange={handleAiToggle}
                                            disabled={!hasAnyAiKey && !config.search.ai_enabled}
                                            aria-label="Enable AI-powered search"
                                        />
                                    </div>
                                </TooltipTrigger>
                                {!hasAnyAiKey && (
                                    <TooltipContent>
                                        <p>Add a Gemini or OpenRouter API key in Integrations to enable AI search</p>
                                    </TooltipContent>
                                )}
                            </Tooltip>
                        </TooltipProvider>
                    </div>

                    {config.search.ai_enabled && (
                        <div className="space-y-4 pt-2 border-t">
                            {/* Provider Selection */}
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4">
                                <div className="min-w-0">
                                    <Label htmlFor="ai-provider" className="text-sm font-medium">Provider</Label>
                                    <p className="text-xs text-muted-foreground">Choose your AI provider</p>
                                </div>
                                <Select
                                    value={config.search.ai_provider || 'gemini'}
                                    onValueChange={(value) => handleAiProviderChange(value as 'gemini' | 'openrouter')}
                                >
                                    <SelectTrigger id="ai-provider" className="w-full sm:w-[200px]">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="gemini" disabled={!hasGeminiKey}>
                                            Google Gemini{!hasGeminiKey ? ' (no key)' : ''}
                                        </SelectItem>
                                        <SelectItem value="openrouter" disabled={!hasOpenRouterKey}>
                                            OpenRouter{!hasOpenRouterKey ? ' (no key)' : ''}
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Model Selection */}
                            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4">
                                <div className="min-w-0">
                                    <Label htmlFor="ai-model" className="text-sm font-medium">Model</Label>
                                    <p className="text-xs text-muted-foreground">
                                        {(config.search.ai_provider || 'gemini') === 'openrouter'
                                            ? 'Any OpenRouter model ID'
                                            : (() => {
                                                const selected = GEMINI_MODELS.find(m => m.id === config.search.ai_model);
                                                return (selected?.grounding || config.search.ai_web_search) ? 'with Web Search' : 'without Web Search';
                                            })()
                                        }
                                    </p>
                                </div>
                                {(config.search.ai_provider || 'gemini') === 'openrouter' ? (
                                    <>
                                        <Input
                                            id="ai-model"
                                            list="openrouter-models"
                                            value={config.search.ai_model ?? ''}
                                            onChange={(e) => handleAiModelChange(e.target.value)}
                                            placeholder={openRouterModelsLoading ? 'Loading models...' : 'e.g. google/gemini-2.5-flash'}
                                            className="w-full sm:w-[280px]"
                                        />
                                        <datalist id="openrouter-models">
                                            {openRouterModels.map(model => (
                                                <option key={model.id} value={model.id}>{model.name}</option>
                                            ))}
                                        </datalist>
                                    </>
                                ) : (
                                    <Select
                                        value={config.search.ai_model || DEFAULT_GEMINI_MODEL}
                                        onValueChange={handleAiModelChange}
                                    >
                                        <SelectTrigger id="ai-model" className="w-full sm:w-[280px]">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {GEMINI_MODELS.map(model => (
                                                <SelectItem key={model.id} value={model.id}>
                                                    {model.name}{model.grounding ? ' (with Web Search)' : ''}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                )}
                            </div>

                            {/* Web Search toggle (Gemini non-free-grounding models only) */}
                            {/* OpenRouter always uses :online — no toggle needed */}
                            {(() => {
                                const provider = config.search.ai_provider || 'gemini';
                                if (provider !== 'gemini') return null;
                                const selected = GEMINI_MODELS.find(m => m.id === config.search.ai_model);
                                if (selected?.grounding) return null; // already has free grounding

                                return (
                                    <>
                                        <div className="flex items-center justify-between gap-4">
                                            <div className="min-w-0 flex-1">
                                                <Label htmlFor="ai-web-search" className="text-sm font-medium">Web Search</Label>
                                                <p className="text-xs text-muted-foreground">
                                                    Requires a paid Gemini API key. Free keys will get 429 errors.
                                                </p>
                                            </div>
                                            <Switch
                                                id="ai-web-search"
                                                className="shrink-0"
                                                checked={!!config.search.ai_web_search}
                                                onCheckedChange={(checked) => setConfig(prev => ({
                                                    ...prev,
                                                    search: { ...prev.search, ai_web_search: checked },
                                                }))}
                                            />
                                        </div>
                                        {!config.search.ai_web_search && (
                                            <div className="flex items-start gap-2 p-3 rounded-md bg-yellow-500/10 border border-yellow-500/20">
                                                <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                                                <p className="text-xs text-yellow-600 dark:text-yellow-400">
                                                    This model cannot search the web on free tier — results may be less accurate for recent or niche content.
                                                    If you have a paid Gemini key, enable "Web Search" above.
                                                </p>
                                            </div>
                                        )}
                                    </>
                                );
                            })()}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Search Ordering */}
            <Card>
                <CardHeader>
                    <CardTitle>Search Catalog Order</CardTitle>
                    <CardDescription>Drag and drop to reorder search catalogs in Stremio</CardDescription>
                </CardHeader>
                <CardContent>
                    <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                    >
                        <SortableContext
                            items={getEnabledSearchProviders().map(p => p.id)}
                            strategy={verticalListSortingStrategy}
                        >
                            <div className="space-y-2">
                                {getEnabledSearchProviders().map(provider => (
                                    <SortableSearchProviderItem
                                        key={provider.id}
                                        provider={provider}
                                        onEditSearchName={handleEditSearchName}
                                        onEngineEnabledChange={handleEngineEnabledChange}
                                        onengineRatingPostersChange={handleengineRatingPostersChange}
                                        getSearchDisplayName={getSearchDisplayName}
                                        getProviderBaseLabel={getProviderBaseLabel}
                                        getSearchCustomName={getSearchCustomName}
                                        getSearchDisplayType={getSearchDisplayType}
                                        hasRPDBKey={hasRPDBKey}
                                        engineRatingPostersEnabled={config.search.engineRatingPosters?.[provider.id] ?? false}
                                    />
                                ))}
                            </div>
                        </SortableContext>
                    </DndContext>
                </CardContent>
            </Card>
        </div>
      )}

      {/* Edit Search Name Dialog */}
      <Dialog open={!!editingProvider} onOpenChange={handleCancelEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Search Catalog</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-search-name">Search Name</Label>
              <Input
                id="edit-search-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSaveSearchName();
                  } else if (e.key === 'Escape') {
                    handleCancelEdit();
                  }
                }}
                autoFocus
                placeholder="Enter custom name for this search"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-search-type">Type</Label>
              <Input
                id="edit-search-type"
                value={editType}
                onChange={(e) => setEditType(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSaveSearchName();
                  } else if (e.key === 'Escape') {
                    handleCancelEdit();
                  }
                }}
                placeholder="Enter custom type for this search"
              />
            </div>
          </div>
          <div className="flex justify-end space-x-2">
            <Button variant="outline" onClick={handleCancelEdit}>
              Cancel
            </Button>
            <Button onClick={handleSaveSearchName} disabled={!editName.trim() || !editType.trim()}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
