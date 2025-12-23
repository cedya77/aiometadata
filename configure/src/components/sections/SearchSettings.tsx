import React, { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useConfig } from '@/contexts/ConfigContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Edit2, GripVertical, Star, Sparkles } from 'lucide-react';
import { allSearchProviders } from '@/data/catalogs';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// Sortable Search Provider Item Component
function SortableSearchProviderItem({ provider, onEditProviderName, onEngineEnabledChange, onengineRatingPostersChange, getProviderDisplayName, getProviderBaseLabel, getProviderCustomName, hasRPDBKey, engineRatingPostersEnabled }: {
  provider: { id: string; type: string; provider: string };
  onEditProviderName: (providerId: string) => void;
  onEngineEnabledChange: (engine: string, checked: boolean) => void;
  onengineRatingPostersChange: (engine: string, checked: boolean) => void;
  getProviderDisplayName: (providerId: string) => string;
  getProviderBaseLabel: (providerId: string) => string;
  getProviderCustomName: (providerId: string) => string;
  hasRPDBKey: boolean;
  engineRatingPostersEnabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: provider.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 'auto',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 p-3 border border-border rounded-lg bg-background ${
        isDragging ? 'opacity-50' : ''
      }`}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing p-1 hover:bg-accent rounded"
      >
        <GripVertical className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1 text-sm">
        <div className="font-medium">
          {getProviderCustomName(provider.provider) || getProviderBaseLabel(provider.provider)}
        </div>
        {getProviderCustomName(provider.provider) && (
          <div className="text-xs text-muted-foreground">
            {getProviderBaseLabel(provider.provider)}
          </div>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onEditProviderName(provider.provider)}
        className="px-2"
      >
        <Edit2 className="h-4 w-4" />
      </Button>
      {hasRPDBKey && provider.provider !== 'tvdb.collections.search' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onengineRatingPostersChange(provider.provider, !engineRatingPostersEnabled)}
          className="px-2"
          title={engineRatingPostersEnabled ? 'Rating posters enabled' : 'Rating posters disabled'}
        >
          <Star className={`h-4 w-4 ${engineRatingPostersEnabled ? 'text-yellow-500 dark:text-yellow-400' : 'text-muted-foreground'}`} />
        </Button>
      )}
      <Switch
        checked={true}
        onCheckedChange={checked => onEngineEnabledChange(provider.provider, checked)}
        aria-label="Enable this engine"
      />
    </div>
  );
}

export function SearchSettings() {
  const { config, setConfig, hasBuiltInTvdb } = useConfig();
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const hasGeminiKey = !!config.apiKeys?.gemini;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Get enabled search providers in order
  const getEnabledSearchProviders = () => {
    const searchOrder = config.search.searchOrder || ['movie', 'series', 'tvdb.collections.search', 'anime_series', 'anime_movie'];
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
    if (config.search.engineEnabled?.['gemini.search'] !== false && config.search.ai_enabled && hasGeminiKey) {
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
    
    // Sort by the searchOrder array
    return enabledProviders.sort((a, b) => {
      const aIndex = searchOrder.indexOf(a.id);
      const bIndex = searchOrder.indexOf(b.id);
      return aIndex - bIndex;
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
      const newSearchOrder = reorderedProviders.map(item => item.id);
      
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

  const getProviderCustomName = (providerId: string) =>
    config.search.providerNames?.[providerId]?.trim() || '';

  const getProviderDisplayName = (providerId: string) => {
    const baseLabel = getProviderBaseLabel(providerId);
    const customName = getProviderCustomName(providerId);

    if (customName && customName !== baseLabel) {
      return `${customName} • ${baseLabel}`;
    }

    return baseLabel;
  };

  const handleEditProviderName = (providerId: string) => {
    setEditingProvider(providerId);
    setEditName(getProviderCustomName(providerId) || getProviderBaseLabel(providerId));
  };

  const handleSaveProviderName = () => {
    if (editingProvider && editName.trim()) {
      setConfig(prev => ({
        ...prev,
        search: {
          ...prev.search,
          providerNames: {
            ...prev.search.providerNames,
            [editingProvider]: editName.trim()
          }
        }
      }));
    }
    setEditingProvider(null);
    setEditName('');
  };

  const handleCancelEdit = () => {
    setEditingProvider(null);
    setEditName('');
  };

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
  const hasRPDBKey = !!config.apiKeys?.rpdb || !!config.apiKeys?.topPoster;
  
  const movieSearchProviders = allSearchProviders.filter(p => {
    if (p.mediaType.includes('movie')) {
      return true;
    }
    return false;
  });
  
  const seriesSearchProviders = allSearchProviders.filter(p => {
    if (p.mediaType.includes('series')) {
      return true;
    }
    return false;
  });
  
  const animeSearchProviders = allSearchProviders.filter(
    p => p.mediaType.includes('anime_movie') || p.mediaType.includes('anime_series')
  );

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Search Settings</h2>
        <p className="text-muted-foreground mt-1">Configure your addon's search functionality.</p>
      </div>

      <Card>
        <CardContent className="p-4 pt-6 flex items-center justify-between">
            <div>
                <Label htmlFor="search-enabled" className="text-lg font-medium">Enable Search functionality</Label>
            </div>
            <Switch 
              id="search-enabled"
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
                                        {getProviderDisplayName(p.value)}{p.value === 'tvdb.search' && !hasTvdbKey && ' (API key required)'}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleEditProviderName(config.search.providers.movie)}
                                className="px-2"
                            >
                                <Edit2 className="h-4 w-4" />
                            </Button>
                            {hasRPDBKey && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleengineRatingPostersChange(config.search.providers.movie, !(config.search.engineRatingPosters?.[config.search.providers.movie] ?? true))}
                                    className="px-2"
                                    title={(config.search.engineRatingPosters?.[config.search.providers.movie] ?? true) ? 'Rating posters enabled' : 'Rating posters disabled'}
                                >
                                    <Star className={`h-4 w-4 ${(config.search.engineRatingPosters?.[config.search.providers.movie] ?? true) ? 'text-yellow-500 dark:text-yellow-400' : 'text-muted-foreground'}`} />
                                </Button>
                            )}
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
                                        {getProviderDisplayName(p.value)}{p.value === 'tvdb.search' && !hasTvdbKey && ' (API key required)'}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleEditProviderName(config.search.providers.series)}
                                className="px-2"
                            >
                                <Edit2 className="h-4 w-4" />
                            </Button>
                            {hasRPDBKey && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleengineRatingPostersChange(config.search.providers.series, !(config.search.engineRatingPosters?.[config.search.providers.series] ?? true))}
                                    className="px-2"
                                    title={(config.search.engineRatingPosters?.[config.search.providers.series] ?? true) ? 'Rating posters enabled' : 'Rating posters disabled'}
                                >
                                    <Star className={`h-4 w-4 ${(config.search.engineRatingPosters?.[config.search.providers.series] ?? true) ? 'text-yellow-500 dark:text-yellow-400' : 'text-muted-foreground'}`} />
                                </Button>
                            )}
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
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleEditProviderName(config.search.providers.anime_series)}
                                className="px-2"
                            >
                                <Edit2 className="h-4 w-4" />
                            </Button>
                            {hasRPDBKey && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleengineRatingPostersChange(config.search.providers.anime_series, !(config.search.engineRatingPosters?.[config.search.providers.anime_series] ?? true))}
                                    className="px-2"
                                    title={(config.search.engineRatingPosters?.[config.search.providers.anime_series] ?? true) ? 'Rating posters enabled' : 'Rating posters disabled'}
                                >
                                    <Star className={`h-4 w-4 ${(config.search.engineRatingPosters?.[config.search.providers.anime_series] ?? true) ? 'text-yellow-500 dark:text-yellow-400' : 'text-muted-foreground'}`} />
                                </Button>
                            )}
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
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleEditProviderName(config.search.providers.anime_movie)}
                                className="px-2"
                            >
                                <Edit2 className="h-4 w-4" />
                            </Button>
                            {hasRPDBKey && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleengineRatingPostersChange(config.search.providers.anime_movie, !(config.search.engineRatingPosters?.[config.search.providers.anime_movie] ?? true))}
                                    className="px-2"
                                    title={(config.search.engineRatingPosters?.[config.search.providers.anime_movie] ?? true) ? 'Rating posters enabled' : 'Rating posters disabled'}
                                >
                                    <Star className={`h-4 w-4 ${(config.search.engineRatingPosters?.[config.search.providers.anime_movie] ?? true) ? 'text-yellow-500 dark:text-yellow-400' : 'text-muted-foreground'}`} />
                                </Button>
                            )}
                            <Switch
                                checked={config.search.engineEnabled?.[config.search.providers.anime_movie] ?? true}
                                onCheckedChange={checked => handleEngineEnabledChange(config.search.providers.anime_movie, checked)}
                                aria-label="Enable this engine"
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
                            <div className="flex items-center gap-3 w-full sm:w-[280px]">
                                <div className="flex-1 text-sm text-muted-foreground border border-input rounded-md bg-stone-900 px-3 py-2 h-10 flex items-center">
                                    {getProviderDisplayName('tvdb.collections.search')}
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handleEditProviderName('tvdb.collections.search')}
                                    className="px-2"
                                >
                                    <Edit2 className="h-4 w-4" />
                                </Button>
                                <Switch
                                    checked={config.search.engineEnabled?.['tvdb.collections.search'] ?? false}
                                    onCheckedChange={checked => handleEngineEnabledChange('tvdb.collections.search', checked)}
                                    aria-label="Enable TVDB Collections search"
                                />
                            </div>
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
                        Use Google Gemini to interpret natural language queries and find media using descriptive phrases instead of exact titles.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between">
                    <div className="flex-1">
                        {!config.apiKeys?.gemini?.trim() && (
                            <p className="text-sm text-muted-foreground">
                                A Gemini API key is required to enable AI search. Add your key in the Integrations settings.
                            </p>
                        )}
                    </div>
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div>
                                    <Switch
                                        id="ai-search-enabled"
                                        checked={config.search.ai_enabled}
                                        onCheckedChange={handleAiToggle}
                                        disabled={!config.apiKeys?.gemini?.trim()}
                                        aria-label="Enable AI-powered search"
                                    />
                                </div>
                            </TooltipTrigger>
                            {!config.apiKeys?.gemini?.trim() && (
                                <TooltipContent>
                                    <p>Add a Gemini API key in Integrations to enable AI search</p>
                                </TooltipContent>
                            )}
                        </Tooltip>
                    </TooltipProvider>
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
                                        onEditProviderName={handleEditProviderName}
                                        onEngineEnabledChange={handleEngineEnabledChange}
                                        onengineRatingPostersChange={handleengineRatingPostersChange}
                                        getProviderDisplayName={getProviderDisplayName}
                                        getProviderBaseLabel={getProviderBaseLabel}
                                        getProviderCustomName={getProviderCustomName}
                                        hasRPDBKey={hasRPDBKey}
                                        engineRatingPostersEnabled={config.search.engineRatingPosters?.[provider.provider] ?? true}
                                    />
                                ))}
                            </div>
                        </SortableContext>
                    </DndContext>
                </CardContent>
            </Card>
        </div>
      )}

      {/* Edit Provider Name Dialog */}
      <Dialog open={!!editingProvider} onOpenChange={handleCancelEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Search Provider Name</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-provider-name">Provider Name</Label>
              <Input
                id="edit-provider-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSaveProviderName();
                  } else if (e.key === 'Escape') {
                    handleCancelEdit();
                  }
                }}
                autoFocus
                placeholder="Enter custom name for this search provider"
              />
            </div>
          </div>
          <div className="flex justify-end space-x-2">
            <Button variant="outline" onClick={handleCancelEdit}>
              Cancel
            </Button>
            <Button onClick={handleSaveProviderName} disabled={!editName.trim()}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
