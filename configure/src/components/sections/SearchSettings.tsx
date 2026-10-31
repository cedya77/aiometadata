import { useEffect, useState, type ReactNode } from 'react';
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
import { GEMINI_MODELS, DEFAULT_GEMINI_MODEL, DEFAULT_OPENROUTER_MODEL, isPresetModel, resolveGeminiModel } from '@/data/ai-models';
import { useOpenRouterModels } from '@/hooks/useOpenRouterModels';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import {
  SEARCH_SLOTS,
  applyReorder,
  listSlots,
  type SearchSlot,
  type SlotView,
} from '@/lib/searchEngines';
import { Callout } from '@/components/settings/Callout';
import { ProviderSelect, type SelectableOption } from '@/components/settings/ProviderSelect';
import { SettingRow } from '@/components/settings/SettingRow';
import { SearchTagRow } from '@/components/SearchTagRow';

// Keep in sync with addon/utils/aiSearchTrigger.ts
const MIN_AI_TRIGGER_KEYWORD_LENGTH = 2;
const MAX_AI_TRIGGER_KEYWORD_LENGTH = 24;

interface EngineRowProps {
  view: SlotView;
  providerOptions: SelectableOption[];
  hasTvdbKey: boolean;
  hasRPDBKey: boolean;
  ratingPostersOn: boolean;
  displayName: string;
  displayType: string;
  onProviderChange: (slotId: string, value: string) => void;
  onEnabledChange: (enabledKey: string, slotId: string, checked: boolean) => void;
  onRatingPostersChange: (slotId: string, checked: boolean) => void;
  onEdit: (slotId: string) => void;
  /** Rendered in the handle column. Omitted entirely for disabled rows. */
  dragHandle?: ReactNode;
  isDragging?: boolean;
}

function EngineRow({
  view,
  providerOptions,
  hasTvdbKey,
  hasRPDBKey,
  ratingPostersOn,
  displayName,
  displayType,
  onProviderChange,
  onEnabledChange,
  onRatingPostersChange,
  onEdit,
  dragHandle,
  isDragging,
}: EngineRowProps) {
  return (
    <div
      data-setting={`search-engine-${view.slot.id}`}
      className={cn(
        'flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 p-3 border border-border rounded-lg bg-background',
        isDragging && 'opacity-50'
      )}
    >
      <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
        {/* A disabled row simply has no drag affordance — nothing is greyed out. */}
        {dragHandle ?? <div className="shrink-0 w-6" aria-hidden="true" />}
        <div className="flex-1 min-w-0 text-sm">
          <div className={cn('font-medium break-words sm:truncate', !view.enabled && 'text-muted-foreground')}>
            {displayName}
          </div>
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <span className="truncate">{view.provider}</span>
            <span className="text-muted-foreground/60 shrink-0">•</span>
            <span className="capitalize truncate">{displayType}</span>
          </div>
          <SearchTagRow searchId={view.slot.id} title={displayName} className="mt-1.5" />
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3 justify-end">
        {view.slot.selectable && (
          <ProviderSelect
            id={`search-engine-${view.slot.id}`}
            ariaLabel={`${displayName} engine`}
            value={view.provider}
            onValueChange={(val) => onProviderChange(view.slot.id, val)}
            options={providerOptions}
            hasTvdbKey={hasTvdbKey}
            className="w-full sm:w-[220px]"
          />
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => onEdit(view.slot.id)}
          className="shrink-0 px-2"
          aria-label={`Edit ${displayName}`}
        >
          <Edit2 className="h-4 w-4" />
        </Button>
        {hasRPDBKey && view.slot.id !== 'tvdb.collections.search' && (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={ratingPostersOn}
            aria-label={`Rating posters for ${displayName}`}
            title={ratingPostersOn ? 'Rating posters enabled' : 'Rating posters disabled'}
            onClick={() => onRatingPostersChange(view.slot.id, !ratingPostersOn)}
            className="shrink-0 px-2"
          >
            <Star className={cn('h-4 w-4', ratingPostersOn ? 'text-yellow-500 dark:text-yellow-400' : 'text-muted-foreground')} />
          </Button>
        )}
        <Switch
          className="shrink-0"
          checked={view.enabled}
          onCheckedChange={(checked) => onEnabledChange(view.enabledKey, view.slot.id, checked)}
          aria-label={`Enable ${displayName}`}
        />
      </div>
    </div>
  );
}

function SortableEngineRow(props: EngineRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.view.slot.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 'auto',
  };

  return (
    <div ref={setNodeRef} style={style}>
      <EngineRow
        {...props}
        isDragging={isDragging}
        dragHandle={
          <div
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab active:cursor-grabbing p-1 hover:bg-accent rounded touch-none"
          >
            <GripVertical className="h-4 w-4 text-muted-foreground" />
          </div>
        }
      />
    </div>
  );
}

export function SearchSettings() {
  const { config, setConfig, hasBuiltInTvdb, hasBuiltInGemini, traktSearchEnabled, simklSearchEnabled, lumiereEnabled, jikanEnabled } = useConfig();
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('');
  const hasGeminiKey = !!config.apiKeys?.gemini || hasBuiltInGemini;
  const hasOpenRouterKey = !!config.apiKeys?.openrouter;
  const hasAnyAiKey = hasGeminiKey || hasOpenRouterKey;
  const { models: openRouterModels, loading: openRouterModelsLoading } = useOpenRouterModels(config.apiKeys?.openrouter);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const hasTvdbKey = !!config.apiKeys?.tvdb?.trim() || hasBuiltInTvdb;
  const hasRPDBKey = !!config.apiKeys?.rpdb || !!config.apiKeys?.topPoster || !!config.customPosterUrlPattern;
  const isTraktSearchEnabled = traktSearchEnabled;
  const isSimklSearchEnabled = simklSearchEnabled;
  const animeSearchFallback = jikanEnabled ? 'mal' : 'kitsu';

  const caps = { hasTvdbKey, hasAnyAiKey };
  const slotViews = listSlots(config, caps);
  const enabledViews = slotViews.filter(v => v.enabled);
  const disabledViews = slotViews.filter(v => !v.enabled);

  const movieSearchProviders = allSearchProviders.filter(p => {
    if ((p.value === 'trakt.search' || p.value === 'trakt.people.search') && !isTraktSearchEnabled) {
      return false;
    }
    if (p.value === 'simkl.search' && !isSimklSearchEnabled) {
      return false;
    }
    if (p.value === 'lumiere.search' && !lumiereEnabled) {
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
    if (p.value === 'simkl.search' && !isSimklSearchEnabled) {
      return false;
    }
    if (p.value === 'lumiere.search' && !lumiereEnabled) {
      return false;
    }
    return p.mediaType.includes('series') &&
           !p.value.includes('people.search') &&
           p.value !== 'mal.search.series' &&
           p.value !== 'kitsu.search.series';
  });

  const animeSearchProviders = allSearchProviders.filter(p => {
    if (p.value.startsWith('simkl.search') && !isSimklSearchEnabled) {
      return false;
    }
    if (p.value.startsWith('mal.search') && !jikanEnabled) {
      return false;
    }
    return p.mediaType.includes('anime_movie') || p.mediaType.includes('anime_series');
  });

  const peopleSearchProviders = allSearchProviders.filter(p => {
    if (p.value === 'trakt.people.search' && !isTraktSearchEnabled) {
      return false;
    }
    if (p.value === 'lumiere.people.search' && !lumiereEnabled) {
      return false;
    }
    return p.value.includes('people.search');
  });

  const toOption = (p: { value: string; label: string }): SelectableOption => ({
    value: p.value,
    label: p.label,
    ...(p.value === 'tvdb.search' || p.value === 'tvdb.people.search'
      ? { requiresKey: 'tvdb' as const }
      : {}),
  });

  const optionsForSlot = (slot: SearchSlot): SelectableOption[] => {
    switch (slot.id) {
      case 'movie':
        return movieSearchProviders.map(toOption);
      case 'series':
        return seriesSearchProviders.map(toOption);
      case 'anime_series':
        return animeSearchProviders.filter(p => p.mediaType.includes('anime_series')).map(toOption);
      case 'anime_movie':
        return animeSearchProviders.filter(p => p.mediaType.includes('anime_movie')).map(toOption);
      case 'people_search_movie':
        return peopleSearchProviders.filter(p => p.mediaType.includes('movie')).map(toOption);
      case 'people_search_series':
        return peopleSearchProviders.filter(p => p.mediaType.includes('series')).map(toOption);
      default:
        return []; // non-selectable slots render no dropdown
    }
  };

  const slotById = (searchId: string) => SEARCH_SLOTS.find(s => s.id === searchId);

  const getSearchCustomName = (searchId: string) =>
    config.search.searchNames?.[searchId]?.trim() || '';

  const getSearchDisplayName = (searchId: string) =>
    getSearchCustomName(searchId) || slotById(searchId)?.defaultName || searchId;

  const getSearchCustomType = (searchId: string) =>
    config.search.searchDisplayTypes?.[searchId]?.trim() || '';

  const getSearchDisplayType = (searchId: string) =>
    getSearchCustomType(searchId) || slotById(searchId)?.defaultType || 'movie';

  const handleEditSearchName = (searchId: string) => {
    setEditingProvider(searchId);
    setEditName(getSearchDisplayName(searchId));
    setEditType(getSearchDisplayType(searchId));
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

  const handleAiTriggerKeywordChange = (keyword: string) => {
    setConfig(prev => ({
      ...prev,
      search: {
        ...prev.search,
        ai_trigger_keyword: keyword,
      },
    }));
  };

  const aiTriggerKeyword = config.search.ai_trigger_keyword ?? '';
  const aiTriggerKeywordTrimmed = aiTriggerKeyword.trim();
  const aiTriggerKeywordTooShort =
    aiTriggerKeywordTrimmed.length > 0 &&
    aiTriggerKeywordTrimmed.length < MIN_AI_TRIGGER_KEYWORD_LENGTH;

  const handleProviderChange = (type: string, value: string) => {
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

  /**
   * Writes the key getManifest.ts actually reads for this slot — provider id for
   * the media slots, slot id for people/AI/collections. The previous UI passed
   * the provider id unconditionally, so people rows wrote an orphan key.
   */
  const handleEnabledChange = (enabledKey: string, slotId: string, checked: boolean) => {
    setConfig(prev => ({
      ...prev,
      search: {
        ...prev.search,
        engineEnabled: {
          ...prev.search.engineEnabled,
          [enabledKey]: checked,
        },
        // gemini.search's row and the AI card's master toggle are one switch.
        ...(slotId === 'gemini.search' && { ai_enabled: checked }),
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

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setConfig(prev => ({
      ...prev,
      search: {
        ...prev.search,
        searchOrder: applyReorder(prev, caps, String(active.id), String(over.id)),
      },
    }));
  };

  useEffect(() => {
    if (!simklSearchEnabled) {
      const updates: Partial<Record<string, string>> = {};
      if (config.search.providers.movie === 'simkl.search') updates.movie = 'tmdb.search';
      if (config.search.providers.series === 'simkl.search') updates.series = 'tvdb.search';
      if (config.search.providers.anime_movie === 'simkl.search.movie') updates.anime_movie = `${animeSearchFallback}.search.movie`;
      if (config.search.providers.anime_series === 'simkl.search.series') updates.anime_series = `${animeSearchFallback}.search.series`;

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
  }, [simklSearchEnabled]);

  useEffect(() => {
    if (jikanEnabled) return;
    const updates: Partial<Record<string, string>> = {};
    if (config.search.providers.anime_movie === 'mal.search.movie') updates.anime_movie = 'kitsu.search.movie';
    if (config.search.providers.anime_series === 'mal.search.series') updates.anime_series = 'kitsu.search.series';
    if (Object.keys(updates).length > 0) {
      setConfig(prev => ({
        ...prev,
        search: { ...prev.search, providers: { ...prev.search.providers, ...updates } },
      }));
    }
  }, [jikanEnabled]);

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

  const rowPropsFor = (view: SlotView): EngineRowProps => ({
    view,
    providerOptions: optionsForSlot(view.slot),
    hasTvdbKey,
    hasRPDBKey,
    ratingPostersOn: config.search.engineRatingPosters?.[view.slot.id] ?? false,
    displayName: getSearchDisplayName(view.slot.id),
    displayType: getSearchDisplayType(view.slot.id),
    onProviderChange: handleProviderChange,
    onEnabledChange: handleEnabledChange,
    onRatingPostersChange: handleengineRatingPostersChange,
    onEdit: handleEditSearchName,
  });

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Search Settings</h2>
        <p className="text-muted-foreground mt-1">Configure your addon's search functionality.</p>
      </div>

      <Card>
        <CardContent className="p-4 pt-6 flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Label htmlFor="search-enabled" className="text-base font-medium">Enable Search functionality</Label>
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
        <div className="space-y-8">
          <Card>
            <CardHeader>
              <CardTitle>Search Engines</CardTitle>
              <CardDescription>
                Choose the engine for each search catalog, enable or disable it, and drag to reorder how they appear in Stremio. Disabled catalogs are listed last.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext
                  items={enabledViews.map(v => v.slot.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-2">
                    {enabledViews.map(view => (
                      <SortableEngineRow key={view.slot.id} {...rowPropsFor(view)} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>

              {disabledViews.length > 0 && (
                <div className="space-y-2 mt-2">
                  {disabledViews.map(view => (
                    <EngineRow key={view.slot.id} {...rowPropsFor(view)} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* AI Search */}
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
              <SettingRow
                htmlFor="ai-search-enabled"
                label="Enable AI Search"
                description={!hasAnyAiKey
                  ? 'A Gemini or OpenRouter API key is required to enable AI search. Add your key in the Integrations settings.'
                  : undefined}
                control={
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
                }
              />

              {config.search.ai_enabled && (
                <div className="space-y-4 pt-2 border-t">
                  <SettingRow
                    htmlFor="ai-provider"
                    label="Provider"
                    description="Choose your AI provider"
                    control={
                      <Select
                        value={config.search.ai_provider || 'gemini'}
                        onValueChange={(value) => handleAiProviderChange(value as 'gemini' | 'openrouter')}
                      >
                        <SelectTrigger id="ai-provider" aria-label="AI provider" className="w-full sm:w-[200px]">
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
                    }
                  />

                  <SettingRow
                    htmlFor="ai-model"
                    label="Model"
                    description={
                      (config.search.ai_provider || 'gemini') === 'openrouter'
                        ? isPresetModel(config.search.ai_model)
                          ? 'Any OpenRouter model ID or @preset/name'
                          : `Any OpenRouter model ID or @preset/name, ${config.search.ai_openrouter_web_search !== false ? 'with Web Search' : 'without Web Search'}`
                        : (() => {
                            const selected = GEMINI_MODELS.find(m => m.id === resolveGeminiModel(config.search.ai_model));
                            return (selected?.grounding && config.search.ai_web_search) ? 'with Web Search' : 'without Web Search';
                          })()
                    }
                    control={
                      (config.search.ai_provider || 'gemini') === 'openrouter' ? (
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
                          value={resolveGeminiModel(config.search.ai_model)}
                          onValueChange={handleAiModelChange}
                        >
                          <SelectTrigger id="ai-model" aria-label="AI model" className="w-full sm:w-[280px]">
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
                      )
                    }
                  />

                  <SettingRow
                    htmlFor="ai-trigger-keyword"
                    label="Trigger Keyword"
                    description="Only run AI search when the query starts with this word. Leave blank to run it on every query. Your other search results are never affected."
                    control={
                      <Input
                        id="ai-trigger-keyword"
                        value={aiTriggerKeyword}
                        onChange={(e) => handleAiTriggerKeywordChange(e.target.value)}
                        onBlur={(e) => handleAiTriggerKeywordChange(e.target.value.trim())}
                        placeholder="e.g. Gemini"
                        maxLength={MAX_AI_TRIGGER_KEYWORD_LENGTH}
                        aria-invalid={aiTriggerKeywordTooShort}
                        className={cn('w-[280px]', aiTriggerKeywordTooShort && 'border-destructive focus-visible:ring-destructive')}
                      />
                    }
                  />

                  {aiTriggerKeywordTooShort && (
                    <p className="text-xs text-destructive">
                      Trigger keyword must be at least {MIN_AI_TRIGGER_KEYWORD_LENGTH} characters, or blank to run AI search on every query.
                    </p>
                  )}

                  {!aiTriggerKeywordTooShort && !!aiTriggerKeywordTrimmed && (
                    <div className="rounded-md bg-muted/40 border border-border p-3 space-y-2">
                      <div className="text-xs">
                        <span className="font-mono break-all">"{aiTriggerKeywordTrimmed} top horror movies of 2026"</span>
                        <p className="text-muted-foreground mt-0.5">AI search runs, on "top horror movies of 2026"</p>
                      </div>
                      <div className="text-xs">
                        <span className="font-mono break-all">"Avengers: Doomsday"</span>
                        <p className="text-muted-foreground mt-0.5">No AI call — no tokens used</p>
                      </div>
                    </div>
                  )}

                  {/* OpenRouter Web Search toggle */}
                  {(() => {
                    const provider = config.search.ai_provider || 'gemini';
                    if (provider !== 'openrouter') return null;
                    const preset = isPresetModel(config.search.ai_model);
                    const enabled = config.search.ai_openrouter_web_search !== false && !preset;

                    return (
                      <>
                        <SettingRow
                          htmlFor="ai-openrouter-web-search"
                          label="Web Search"
                          description={preset
                            ? 'A preset takes web search from its own settings on OpenRouter.'
                            : 'Adds :online so the model sees live results. Billed by OpenRouter at roughly $0.005 per search, on top of the model.'}
                          control={
                            <Switch
                              id="ai-openrouter-web-search"
                              className="shrink-0"
                              checked={enabled}
                              disabled={preset}
                              onCheckedChange={(checked) => setConfig(prev => ({
                                ...prev,
                                search: { ...prev.search, ai_openrouter_web_search: checked },
                              }))}
                            />
                          }
                        />
                        {enabled && (
                          <Callout variant="warn" className="text-xs">
                            Needs credits even on :free models. Turn it off to run on a zero balance.
                          </Callout>
                        )}
                      </>
                    );
                  })()}

                  {/* Web Search toggle (Gemini non-free-grounding models only) */}
                  {(() => {
                    const provider = config.search.ai_provider || 'gemini';
                    if (provider !== 'gemini') return null;
                    const selected = GEMINI_MODELS.find(m => m.id === resolveGeminiModel(config.search.ai_model));
                    if (selected && !selected.grounding) return null;

                    return (
                      <>
                        <SettingRow
                          htmlFor="ai-web-search"
                          label="Web Search"
                          description="Billed by Google on most models. If the key is refused, the search runs without it."
                          control={
                            <Switch
                              id="ai-web-search"
                              className="shrink-0"
                              checked={!!config.search.ai_web_search}
                              onCheckedChange={(checked) => setConfig(prev => ({
                                ...prev,
                                search: { ...prev.search, ai_web_search: checked },
                              }))}
                            />
                          }
                        />
                        {!config.search.ai_web_search && (
                          <Callout variant="warn" className="text-xs">
                            Answers come from the model's own knowledge, so recent or niche titles may be missed.
                            Turn on "Web Search" above if your Gemini key is billed for it.
                          </Callout>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
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
