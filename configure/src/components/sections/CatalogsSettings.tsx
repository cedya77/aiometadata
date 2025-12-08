import React, { useState, useMemo, useEffect } from 'react';
import { MDBListIntegration } from './MDBListIntegration';
import { TraktIntegration } from './TraktIntegration';
import { CustomManifestIntegration } from './CustomManifestIntegration';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Eye, EyeOff, Home, GripVertical, RefreshCw, Trash2, Pencil, Settings, ExternalLink, Star, Shuffle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { streamingServices, regions } from "@/data/streamings";
import { allCatalogDefinitions } from '@/data/catalogs';
import { GenreSelection } from '@/data/genres';
import { SelectionProvider, useSelection } from '@/contexts/SelectionContext';
import { BulkActionBar } from '@/components/BulkActionBar';
import { SelectAllControl } from '@/components/SelectAllControl';
import { SelectBySourceControl } from '@/components/SelectBySourceControl';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  showBulkEnableSuccess,
  showBulkDisableSuccess,
  showBulkAddToHomeSuccess,
  showBulkRemoveFromHomeSuccess,
  showBulkDeleteSuccess,
  showBulkActionError
} from '@/utils/toastHelpers';
import { toast } from 'sonner';

type TraktSortOption = 'rank' | 'added' | 'title' | 'released' | 'runtime' | 'popularity' | 'random' | 'percentage' | 'imdb_rating' | 'tmdb_rating' | 'rt_tomatometer' | 'rt_audience' | 'metascore' | 'votes' | 'imdb_votes' | 'tmdb_votes' | 'my_rating' | 'watched' | 'collected';

const TRAKT_SORT_OPTIONS: { value: TraktSortOption; label: string; vip?: boolean }[] = [
  { value: 'rank', label: 'Rank' },
  { value: 'added', label: 'Added' },
  { value: 'title', label: 'Title' },
  { value: 'released', label: 'Released' },
  { value: 'runtime', label: 'Runtime' },
  { value: 'popularity', label: 'Popularity' },
  { value: 'random', label: 'Random' },
  { value: 'percentage', label: 'Percentage' },
  { value: 'imdb_rating', label: 'IMDb Rating', vip: true },
  { value: 'tmdb_rating', label: 'TMDb Rating', vip: true },
  { value: 'rt_tomatometer', label: 'RT Tomatometer', vip: true },
  { value: 'rt_audience', label: 'RT Audience', vip: true },
  { value: 'metascore', label: 'Metascore', vip: true },
  { value: 'votes', label: 'Votes', vip: true },
  { value: 'imdb_votes', label: 'IMDb Votes', vip: true },
  { value: 'tmdb_votes', label: 'TMDb Votes', vip: true },
  { value: 'my_rating', label: 'My Rating' },
  { value: 'watched', label: 'Watched' },
  { value: 'collected', label: 'Collected' },
];

const sourceBadgeStyles = {
  tmdb: "bg-blue-800/80 text-blue-200 border-blue-600/50 hover:bg-blue-800",
  tvdb: "bg-green-800/80 text-green-200 border-green-600/50 hover:bg-green-800",
  mal: "bg-indigo-800/80 text-indigo-200 border-indigo-600/50 hover:bg-indigo-800",
  tvmaze: "bg-orange-800/80 text-orange-200 border-orange-600/50 hover:bg-orange-800",
  mdblist: "bg-yellow-800/80 text-yellow-200 border-yellow-600/50 hover:bg-yellow-800",
  stremthru: "bg-purple-800/80 text-purple-200 border-purple-600/50 hover:bg-purple-800",
  custom: "bg-pink-800/80 text-pink-200 border-pink-600/50 hover:bg-pink-800",
  trakt: "bg-red-800/80 text-red-200 border-red-600/50 hover:bg-red-800",
};



const MDBListSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, catalogTTL, config } = useConfig();
  const [sort, setSort] = useState<'rank' | 'score' | 'usort' | 'score_average' | 'released' | 'releasedigital' | 'imdbrating' | 'imdbvotes' | 'last_air_date' | 'imdbpopular' | 'tmdbpopular' | 'rogerbert' | 'rtomatoes' | 'rtaudience' | 'metacritic' | 'myanimelist' | 'letterrating' | 'lettervotes' | 'budget' | 'revenue' | 'runtime' | 'title' | 'added' | 'random' | 'default'>(catalog.sort || 'default');
  const [order, setOrder] = useState<'asc' | 'desc'>(catalog.order || 'asc');
  const [cacheTTL, setCacheTTL] = useState<number>(catalog.cacheTTL || catalogTTL);
  const [genreSelection, setGenreSelection] = useState<GenreSelection>(catalog.genreSelection || 'standard');
  const [enableRatingPosters, setEnableRatingPosters] = useState<boolean>(catalog.enableRatingPosters !== false);

  const handleSave = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? { ...c, sort, order, cacheTTL: Math.max(cacheTTL, 300), genreSelection, enableRatingPosters }
          : c
      )
    }));
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>MDBList Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Sort By</Label>
            <Select value={sort} onValueChange={(value: 'rank' | 'score' | 'usort' | 'score_average' | 'released' | 'releasedigital' | 'imdbrating' | 'imdbvotes' | 'last_air_date' | 'imdbpopular' | 'tmdbpopular' | 'rogerbert' | 'rtomatoes' | 'rtaudience' | 'metacritic' | 'myanimelist' | 'letterrating' | 'lettervotes' | 'budget' | 'revenue' | 'runtime' | 'title' | 'added' | 'random' | 'default') => setSort(value)}>
              <SelectTrigger>
                <SelectValue placeholder="Select sort option" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Use Default Sorting</SelectItem>
                <SelectItem value="rank">Rank</SelectItem>
                <SelectItem value="score">Score</SelectItem>
                <SelectItem value="usort">User Sort</SelectItem>
                <SelectItem value="score_average">Score Average</SelectItem>
                <SelectItem value="released">Release Date</SelectItem>
                <SelectItem value="releasedigital">Digital Release</SelectItem>
                <SelectItem value="imdbrating">IMDB Rating</SelectItem>
                <SelectItem value="imdbvotes">IMDB Votes</SelectItem>
                <SelectItem value="last_air_date">Last Air Date</SelectItem>
                <SelectItem value="imdbpopular">IMDB Popular</SelectItem>
                <SelectItem value="tmdbpopular">TMDB Popular</SelectItem>
                <SelectItem value="rogerbert">Roger Ebert</SelectItem>
                <SelectItem value="rtomatoes">Rotten Tomatoes</SelectItem>
                <SelectItem value="rtaudience">RT Audience</SelectItem>
                <SelectItem value="metacritic">Metacritic</SelectItem>
                <SelectItem value="myanimelist">MyAnimeList</SelectItem>
                <SelectItem value="letterrating">Letterboxd Rating</SelectItem>
                <SelectItem value="lettervotes">Letterboxd Votes</SelectItem>
                <SelectItem value="budget">Budget</SelectItem>
                <SelectItem value="revenue">Revenue</SelectItem>
                <SelectItem value="runtime">Runtime</SelectItem>
                <SelectItem value="title">Title</SelectItem>
                <SelectItem value="added">Date Added</SelectItem>
                <SelectItem value="random">Random</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {sort !== 'default' && (
            <div className="space-y-2">
              <Label>Order</Label>
              <Select value={order} onValueChange={(value: 'asc' | 'desc') => setOrder(value)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select order" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asc">Ascending</SelectItem>
                  <SelectItem value="desc">Descending</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label>Cache TTL (seconds)</Label>
            <div className="flex items-center space-x-2">
              <input
                type="number"
                value={cacheTTL}
                onChange={(e) => setCacheTTL(parseInt(e.target.value) || catalogTTL)}
                min="300"
                max="604800"
                step="3600"
                className="flex-1 px-3 py-2 border border-input bg-background rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                placeholder={catalogTTL.toString()}
              />
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                ({Math.floor(cacheTTL / 3600)}h {Math.floor((cacheTTL % 3600) / 60)}m)
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              How long to cache this list before refreshing. Range: 5 minutes to 7 days.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Genre Selection</Label>
            <Select value={genreSelection} onValueChange={(value: GenreSelection) => setGenreSelection(value)}>
              <SelectTrigger>
                <SelectValue placeholder="Select genre set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">Standard Genres Only (44 genres)</SelectItem>
                <SelectItem value="anime">Anime Genres Only (22 genres)</SelectItem>
                <SelectItem value="all">All Genres (66 genres including anime)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Choose which genre set to use for this specific list.
            </p>
          </div>
          {config.apiKeys?.rpdb && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="mdblist-rating-posters-toggle">Enable Rating Posters</Label>
                  <p className="text-xs text-muted-foreground">
                    Use RatingPosterDB or other providers for enhanced posters
                  </p>
                </div>
                <Switch
                  id="mdblist-rating-posters-toggle"
                  checked={enableRatingPosters}
                  onCheckedChange={setEnableRatingPosters}
                />
              </div>
            </div>
          )}
        </div>
        <div className="text-xs text-muted-foreground mb-4">
          Note: Changes will take effect after you save your configuration in the Configuration Manager.
        </div>
        <div className="flex justify-end space-x-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const TraktSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, catalogTTL } = useConfig();
  const [sort, setSort] = useState<TraktSortOption>(catalog.sort as TraktSortOption || 'added');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(catalog.sortDirection as 'asc' | 'desc' || 'asc');
  const [cacheTTL, setCacheTTL] = useState<number>(catalog.cacheTTL || catalogTTL);
  
  const minCacheTTL = 300; // 5 minutes minimum for all Trakt catalogs

  const handleSave = () => {
    setConfig(prev => {
      const updatedCatalogs = prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? { ...c, sort, sortDirection, cacheTTL: Math.max(cacheTTL, minCacheTTL) }
          : c
      ) as CatalogConfig[];

      return {
        ...prev,
        catalogs: updatedCatalogs,
      };
    });
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trakt Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Sort By</Label>
            <Select value={sort} onValueChange={(value) => setSort(value as TraktSortOption)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <TooltipProvider>
                  {TRAKT_SORT_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="flex items-center gap-1">
                        {option.label}
                        {option.vip && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span role="img" aria-label="VIP" className="ml-1">💎</span>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs whitespace-normal">
                              VIP Only: Requires Trakt VIP subscription
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </TooltipProvider>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Sort Direction</Label>
            <Select value={sortDirection} onValueChange={(value) => setSortDirection(value as 'asc' | 'desc')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Cache TTL (seconds)</Label>
            <Input
              type="number"
              min={5}
              value={cacheTTL}
              onChange={(e) => setCacheTTL(Number(e.target.value) || 0)}
            />
            <p className="text-xs text-muted-foreground">
              Minimum 5 minutes to avoid excessive API calls
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button onClick={handleSave}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const CustomManifestSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, catalogTTL, config } = useConfig();
  const [cacheTTL, setCacheTTL] = useState<number>(catalog.cacheTTL || catalogTTL);
  const [enableRatingPosters, setEnableRatingPosters] = useState<boolean>(catalog.enableRatingPosters !== false);
  const [pageSize, setPageSize] = useState<number>(catalog.pageSize || 100);

  const handleSave = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? { ...c, cacheTTL: Math.max(cacheTTL, 300), enableRatingPosters, pageSize }
          : c
      )
    }));
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Custom Manifest Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="custom-cache-ttl">Cache TTL (seconds)</Label>
            <div className="flex items-center space-x-2">
              <input
                id="custom-cache-ttl"
                type="number"
                value={cacheTTL}
                onChange={(e) => setCacheTTL(parseInt(e.target.value) || catalogTTL)}
                min="300"
                max="604800"
                step="3600"
                className="flex-1 px-3 py-2 border border-input bg-background rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                placeholder={catalogTTL.toString()}
              />
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                ({Math.floor(cacheTTL / 3600)}h {Math.floor((cacheTTL % 3600) / 60)}m)
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              How long to cache this catalog before refreshing. Range: 5 minutes to 7 days.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="custom-page-size">Page Size</Label>
            <div className="flex items-center space-x-2">
              <input
                id="custom-page-size"
                type="number"
                value={pageSize}
                onChange={(e) => setPageSize(parseInt(e.target.value) || 100)}
                min="1"
                max="1000"
                step="1"
                className="flex-1 px-3 py-2 border border-input bg-background rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                placeholder="100"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Number of items per page for this catalog. Default: 100. This should match the imported addon's page size for accurate pagination.
            </p>
          </div>
          {config.apiKeys?.rpdb && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="custom-rating-posters-toggle">Enable Rating Posters</Label>
                  <p className="text-xs text-muted-foreground">
                    Use RatingPosterDB or other providers for enhanced posters
                  </p>
                </div>
                <Switch
                  id="custom-rating-posters-toggle"
                  checked={enableRatingPosters}
                  onCheckedChange={setEnableRatingPosters}
                />
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end space-x-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const SortableCatalogItem = ({ catalog }: { catalog: CatalogConfig & { source?: string }; }) => {
  const { setConfig, config } = useConfig();
  const { toggleSelection, isSelected } = useSelection();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: `${catalog.id}-${catalog.type}` });
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [newName, setNewName] = useState(catalog.name);
  const [newType, setNewType] = useState(catalog.displayType || catalog.type);
  const [showSettings, setShowSettings] = useState(false);

  const catalogKey = `${catalog.id}-${catalog.type}`;
  const selected = isSelected(catalogKey);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 'auto',
  };

  const badgeSource = catalog.source || 'custom';
  const badgeStyle = sourceBadgeStyles[badgeSource as keyof typeof sourceBadgeStyles] || "bg-gray-700";

  const [isRippling, setIsRippling] = useState(false);

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleSelection(catalogKey);
    
    // Trigger ripple effect
    setIsRippling(true);
    setTimeout(() => setIsRippling(false), 600);
  };

  const handleToggleEnabled = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c => {
        if (c.id === catalog.id && c.type === catalog.type) {
          const isNowEnabled = !c.enabled;
          return { ...c, enabled: isNowEnabled, showInHome: isNowEnabled ? c.showInHome : false };
        }
        return c;
      })
    }));
  };

  const handleToggleShowInHome = () => {
    if (!catalog.enabled) return;
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        (c.id === catalog.id && c.type === catalog.type) ? { ...c, showInHome: !c.showInHome } : c
      )
    }));
  };

  const handleToggleRatingPosters = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        (c.id === catalog.id && c.type === catalog.type) ? { ...c, enableRatingPosters: !c.enableRatingPosters } : c
      )
    }));
  };

  const handleToggleRandomize = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        (c.id === catalog.id && c.type === catalog.type)
          ? { ...c, randomizePerPage: !c.randomizePerPage }
          : c
      )
    }));
  };

  const handleEditSave = () => {
    const trimmedName = newName.trim();
    const trimmedType = newType.trim();

    if (trimmedName === '' || trimmedType === '') {
      // Revert to original values if either field is empty
      setNewName(catalog.name);
      setNewType(catalog.displayType || catalog.type);
      setShowEditDialog(false);
      return;
    }

    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        (c.id === catalog.id && c.type === catalog.type)
          ? { ...c, name: trimmedName, displayType: trimmedType }
          : c
      )
    }));
    setShowEditDialog(false);
  };

  const handleEditCancel = () => {
    setNewName(catalog.name);
    setNewType(catalog.displayType || catalog.type);
    setShowEditDialog(false);
  };

  const handleDelete = () => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.filter(c => !(c.id === catalog.id && c.type === catalog.type)),
    }));
  };

  const handleMoveToTop = () => {
    setConfig(prev => {
      const currentIndex = prev.catalogs.findIndex(c => c.id === catalog.id && c.type === catalog.type);
      if (currentIndex <= 0) return prev; // Already at top or not found

      const newCatalogs = [...prev.catalogs];
      const [movedCatalog] = newCatalogs.splice(currentIndex, 1);
      newCatalogs.unshift(movedCatalog);

      return {
        ...prev,
        catalogs: newCatalogs,
      };
    });
  };

  const handleMoveToBottom = () => {
    setConfig(prev => {
      const currentIndex = prev.catalogs.findIndex(c => c.id === catalog.id && c.type === catalog.type);
      if (currentIndex === -1 || currentIndex === prev.catalogs.length - 1) return prev; // Not found or already at bottom

      const newCatalogs = [...prev.catalogs];
      const [movedCatalog] = newCatalogs.splice(currentIndex, 1);
      newCatalogs.push(movedCatalog);

      return {
        ...prev,
        catalogs: newCatalogs,
      };
    });
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex flex-col md:flex-row md:items-center md:justify-between p-4",
        // Smooth transitions for all properties
        "transition-all duration-200 ease-out",
        // Dragging state
        isDragging && "opacity-50 scale-105 shadow-lg",
        // Disabled state
        !catalog.enabled && "opacity-60",
        // Selected state with smooth background transition
        selected && "bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-700",
        // Hover effect for selected items (slightly darker)
        selected && "hover:bg-blue-100 dark:hover:bg-blue-950/50",
        // Hover effect for non-selected items
        !selected && "hover:bg-accent/50"
      )}
    >
      {/* Row 1: Catalog info (checkbox, drag, name) */}
      <div className="flex items-center space-x-4 w-full md:w-auto">
        <div
          onClick={handleCheckboxClick}
          className="flex items-center cursor-pointer p-2 -ml-2 min-w-[40px] min-h-[40px] md:min-w-0 md:min-h-0"
          role="checkbox"
          aria-checked={selected}
          aria-label="Select catalog"
        >
          <div className={cn(
            "w-5 h-5 border-2 rounded flex items-center justify-center",
            // Smooth color transitions
            "transition-all duration-200 ease-out",
            // Ripple effect container
            "checkbox-ripple",
            isRippling && "ripple-active",
            // Selected state
            selected && "bg-blue-600 border-blue-600 dark:bg-blue-500 dark:border-blue-500",
            // Unselected state with hover
            !selected && "border-gray-400 dark:border-gray-600 hover:border-blue-500 dark:hover:border-blue-400 hover:scale-110"
          )}>
            {selected && (
              <svg
                className="w-3.5 h-3.5 text-white transition-transform duration-200 ease-out"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path d="M5 13l4 4L19 7" />
              </svg>
            )}
          </div>
        </div>
        <button {...attributes} {...listeners} className="cursor-grab text-muted-foreground p-2 -ml-2 touch-none" aria-label="Drag to reorder">
          <GripVertical />
        </button>
        <div>
          <div className="flex items-center gap-2">
            <p className={`font-medium transition-colors ${catalog.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>{catalog.name}</p>
            <button
              onClick={() => setShowEditDialog(true)}
              className="text-muted-foreground hover:text-foreground"
            >
              <Pencil size={14} />
            </button>
          </div>
          <div>
            <p className={`text-sm transition-colors ${catalog.enabled ? 'text-muted-foreground' : 'text-muted-foreground/50'} capitalize`}>
              {catalog.displayType || catalog.type}
            </p>
          </div>
        </div>
      </div>

      {/* Row 2: Action buttons + Source badge */}
      <div className="flex items-center space-x-2 mt-3 md:mt-0 md:ml-auto justify-start md:justify-end">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleToggleEnabled}>
                {catalog.enabled ? (
                  <Eye className="h-5 w-5 text-green-500 dark:text-green-400" />
                ) : (
                  <EyeOff className="h-5 w-5 text-muted-foreground" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>{catalog.enabled ? 'Enabled (Visible)' : 'Disabled'}</p></TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleToggleShowInHome}
                disabled={!catalog.enabled}
                className="disabled:opacity-20 disabled:cursor-not-allowed"
              >
                <Home className={`h-5 w-5 transition-colors ${catalog.showInHome && catalog.enabled ? 'text-blue-500 dark:text-blue-400' : 'text-muted-foreground'}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>{catalog.showInHome && catalog.enabled ? 'Featured on Home Board' : 'Not on Home Board'}</p></TooltipContent>
          </Tooltip>

          {config.apiKeys?.rpdb && (
            <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleToggleRatingPosters}
                disabled={!catalog.enabled}
                className="disabled:opacity-20 disabled:cursor-not-allowed"
              >
                <Star className={`h-5 w-5 transition-colors ${catalog.enableRatingPosters !== false && catalog.enabled ? 'text-yellow-500 dark:text-yellow-400' : 'text-muted-foreground'}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>{catalog.enableRatingPosters !== false && catalog.enabled ? 'Rating Posters Enabled' : 'Rating Posters Disabled'}</p></TooltipContent>
          </Tooltip>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleToggleRandomize}
                disabled={!catalog.enabled}
                className="disabled:opacity-20 disabled:cursor-not-allowed"
                aria-label="Toggle random order"
              >
                <Shuffle className={`h-5 w-5 transition-colors ${catalog.randomizePerPage && catalog.enabled ? 'text-purple-500 dark:text-purple-400' : 'text-muted-foreground'}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{catalog.randomizePerPage && catalog.enabled ? 'Randomized per page' : 'Original order'}</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleMoveToTop} aria-label="Move to Top" className="h-8 w-8">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256" className="text-muted-foreground hover:text-foreground" fill="currentColor">
                  <path d="M213.66,194.34a8,8,0,0,1-11.32,11.32L128,131.31,53.66,205.66a8,8,0,0,1-11.32-11.32l80-80a8,8,0,0,1,11.32,0Zm-160-68.68L128,51.31l74.34,74.35a8,8,0,0,0,11.32-11.32l-80-80a8,8,0,0,0-11.32,0l-80,80a8,8,0,0,0,11.32,11.32Z" />
                </svg>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Move to top of list</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleMoveToBottom} aria-label="Move to Bottom" className="h-8 w-8">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256" className="text-muted-foreground hover:text-foreground" fill="currentColor">
                  <path d="M213.66,130.34a8,8,0,0,1,0,11.32l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,204.69l74.34-74.35A8,8,0,0,1,213.66,130.34Zm-91.32,11.32a8,8,0,0,0,11.32,0l80-80a8,8,0,0,0-11.32-11.32L128,124.69,53.66,50.34A8,8,0,0,0,42.34,61.66Z" />
                </svg>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Move to bottom of list</TooltipContent>
          </Tooltip>


          {(catalog.source === 'mdblist' || catalog.source === 'trakt') && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setShowSettings(true)} aria-label="Sort Settings">
                  <Settings className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{catalog.source === 'trakt' ? 'Trakt Settings' : 'Sort Settings'}</TooltipContent>
            </Tooltip>
          )}

          {catalog.source === 'custom' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setShowSettings(true)} aria-label="Cache Settings">
                  <Settings className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Cache Settings</TooltipContent>
            </Tooltip>
          )}

          {catalog.source === 'custom' && catalog.sourceUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    try {
                      // For StremThru catalogs, use the manifest URL instead of sourceUrl
                      let urlToUse = catalog.sourceUrl;
                      
                      // If this is a StremThru catalog, extract the manifest URL from the sourceUrl
                      if (catalog.source === 'stremthru' && catalog.sourceUrl) {
                        // Extract manifest URL from the full catalog URL
                        // e.g., /stremio/list/CONFIG_STRING/catalog/series/CATALOG_ID.json -> /stremio/list/CONFIG_STRING/manifest.json
                        const url = new URL(catalog.sourceUrl);
                        const pathParts = url.pathname.split('/').filter(Boolean);
                        const stremioIndex = pathParts.indexOf('stremio');
                        
                        if (stremioIndex !== -1) {
                          // Keep only: stremio, list, and the config string (3 segments total)
                          const baseParts = pathParts.slice(0, stremioIndex + 3);
                          const basePath = '/' + baseParts.join('/');
                          urlToUse = `${url.origin}${basePath}/manifest.json`;
                        }
                      }
                      
                      // Now construct the configure URL
                      const url = new URL(urlToUse!);
                      const pathParts = url.pathname.split('/').filter(Boolean);
                      
                      // Handle StremThru URLs specifically - simple approach
                      if (url.hostname.includes('stremthru') || pathParts.includes('stremio')) {
                        // For StremThru: just replace 'manifest.json' with 'configure'
                        const configureUrl = urlToUse!.replace('/manifest.json', '/configure');
                        window.open(configureUrl, '_blank', 'noopener,noreferrer');
                        return;
                      }
                      
                      // Default behavior for other URLs
                      const basePath = pathParts.length > 0 ? '/' + pathParts[0] : '';
                      const configureUrl = `${url.origin}${basePath}/configure`;
                      window.open(configureUrl, '_blank', 'noopener,noreferrer');
                    } catch (error) {
                      console.error('Failed to open configure URL:', error);
                    }
                  }}
                  aria-label="Open Manifest Configuration"
                >
                  <ExternalLink className="h-5 w-5 text-blue-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open manifest configuration page</TooltipContent>
            </Tooltip>
          )}

          {(catalog.source === 'mdblist' || catalog.source === 'streaming' || catalog.source === 'stremthru' || catalog.source === 'custom' || catalog.source === 'trakt') && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleDelete} aria-label="Delete Catalog">
                  <Trash2 className="h-5 w-5 text-red-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove from your catalog list</TooltipContent>
            </Tooltip>
          )}
        </TooltipProvider>
        <div className="flex-shrink-0">
          <Badge variant="outline" className={`font-semibold ${badgeStyle}`}>
            {badgeSource.toUpperCase()}
          </Badge>
        </div>
      </div>

      <MDBListSettingsDialog
        catalog={catalog}
        isOpen={showSettings && catalog.source === 'mdblist'}
        onClose={() => setShowSettings(false)}
      />

      <TraktSettingsDialog
        catalog={catalog}
        isOpen={showSettings && catalog.source === 'trakt'}
        onClose={() => setShowSettings(false)}
      />

      <CustomManifestSettingsDialog
        catalog={catalog}
        isOpen={showSettings && catalog.source === 'custom'}
        onClose={() => setShowSettings(false)}
      />

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Catalog</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name</Label>
              <Input
                id="edit-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleEditSave();
                  } else if (e.key === 'Escape') {
                    handleEditCancel();
                  }
                }}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-type">Type</Label>
              <Input
                id="edit-type"
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleEditSave();
                  } else if (e.key === 'Escape') {
                    handleEditCancel();
                  }
                }}
              />
            </div>
          </div>
          <div className="flex justify-end space-x-2">
            <Button variant="outline" onClick={handleEditCancel}>
              Cancel
            </Button>
            <Button onClick={handleEditSave}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
};

const StreamingProvidersSettings = ({ open, onClose, selectedProviders, setSelectedProviders, onSave }) => {
  const [selectedCountry, setSelectedCountry] = useState('Any');

  const showProvider = (serviceId: string) => {
    const countryList = regions[selectedCountry as keyof typeof regions];
    return Array.isArray(countryList) && countryList.includes(serviceId);
  };

  const toggleService = (serviceId: string) => {
    setSelectedProviders((prev: string[] = []) =>
      Array.isArray(prev) && prev.includes(serviceId)
        ? prev.filter(id => id !== serviceId)
        : [...(prev || []), serviceId]
    );
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage Streaming Providers</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-2">Filter providers by country:</p>
            <Select value={selectedCountry} onValueChange={setSelectedCountry}>
              <SelectTrigger className="bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-background border shadow-md">
                {Object.keys(regions).map((country) => (
                  <SelectItem key={country} value={country} className="cursor-pointer">
                    {country}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-5 gap-4">
            {streamingServices.map((service) => (
              showProvider(service.id) && (
                <button
                  key={service.id}
                  onClick={() => toggleService(service.id)}
                  className={`w-12 h-12 sm:w-14 sm:h-14 rounded-xl border transition-opacity ${Array.isArray(selectedProviders) && selectedProviders.includes(service.id)
                      ? "border-primary bg-primary/5"
                      : "border-border opacity-50 hover:opacity-100"
                    }`}
                  title={service.name}
                >
                  <img
                    src={service.icon}
                    alt={service.name}
                    className="w-full h-full rounded-lg object-cover"
                  />
                </button>
              )
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline" type="button" onClick={onClose}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={onSave}>
              Save Changes
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// Inner component that consumes SelectionContext
function CatalogsSettingsContent({
  hideDisabledCatalogs,
  setHideDisabledCatalogs
}: {
  hideDisabledCatalogs: boolean;
  setHideDisabledCatalogs: (value: boolean) => void;
}) {
  const { config, setConfig, hasBuiltInTvdb } = useConfig();
  const {
    selectAll,
    deselectAll,
    selectBySource,
    deselectBySource,
    invertSelection,
    selectionCount,
    selectedIds
  } = useSelection();
  const [isMdbListOpen, setIsMdbListOpen] = useState(false);
  const [isTraktOpen, setIsTraktOpen] = useState(false);
  const [isCustomManifestOpen, setIsCustomManifestOpen] = useState(false);
  const [streamingDialogOpen, setStreamingDialogOpen] = useState(false);
  const [tempSelectedProviders, setTempSelectedProviders] = useState<string[]>([]);
  const [showDeleteConfirmDialog, setShowDeleteConfirmDialog] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingAction, setLoadingAction] = useState<
    | 'enable'
    | 'disable'
    | 'addToHome'
    | 'removeFromHome'
    | 'delete'
    | 'invert'
    | 'enableRatingPosters'
    | 'disableRatingPosters'
    | 'enableRandomize'
    | 'disableRandomize'
    | null
  >(null);
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  // Check if TVDB key is available
  const hasTvdbKey = !!config.apiKeys?.tvdb?.trim() || hasBuiltInTvdb;

  // Auto-disable TVDB catalogs when no TVDB key is available
  React.useEffect(() => {
    if (!hasTvdbKey) {
      const hasEnabledTvdbCatalogs = config.catalogs.some(cat => cat.source === 'tvdb' && cat.enabled);
      if (hasEnabledTvdbCatalogs) {
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.map(cat =>
            cat.source === 'tvdb' ? { ...cat, enabled: false } : cat
          )
        }));
      }
    }
  }, [hasTvdbKey, config.catalogs, setConfig]);

  const filteredCatalogs = useMemo(() =>
    config.catalogs.filter(cat => {
      // Filter out disabled catalogs if hideDisabledCatalogs is true
      if (hideDisabledCatalogs && !cat.enabled) return false;

      // Filter out TVDB catalogs if no TVDB key is available
      if (cat.source === 'tvdb' && !hasTvdbKey) return false;

      if (cat.source !== "streaming") return true;
      const serviceId = cat.id.replace("streaming.", "").replace(/ .*/, "");
      return Array.isArray(config.streaming) && config.streaming.includes(serviceId);
    }),
    [config.catalogs, config.streaming, hideDisabledCatalogs, hasTvdbKey]
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setConfig(prev => {
        const oldIndex = prev.catalogs.findIndex(c => `${c.id}-${c.type}` === active.id);
        const newIndex = prev.catalogs.findIndex(c => `${c.id}-${c.type}` === over.id);
        return { ...prev, catalogs: arrayMove(prev.catalogs, oldIndex, newIndex) };
      });
    }
  };

  const catalogItemIds = filteredCatalogs.map(c => `${c.id}-${c.type}`);

  // Helper function to get actual selected streaming services from catalogs
  const getActualSelectedStreamingServices = (): string[] => {
    const streamingCatalogs = config.catalogs?.filter(c => c.source === 'streaming' && c.enabled) || [];
    const serviceIds = new Set<string>();

    streamingCatalogs.forEach(catalog => {
      const serviceId = catalog.id.replace('streaming.', '');
      serviceIds.add(serviceId);
    });

    return Array.from(serviceIds);
  };

  const handleOpenStreamingDialog = () => {
    // Only show services as selected if they have enabled catalogs
    const enabledStreamingServices = getActualSelectedStreamingServices();
    setTempSelectedProviders(enabledStreamingServices);
    setStreamingDialogOpen(true);
  };

  const handleCloseStreamingDialog = () => {
    console.log('🔗 [Streaming] Saving with selectedServices:', tempSelectedProviders);
    setConfig(prev => {
      const selectedServices = tempSelectedProviders;

      let newCatalogs = [...prev.catalogs];

      // Get all streaming services that currently have catalogs
      const currentStreamingServices = new Set<string>();
      prev.catalogs.forEach(catalog => {
        if (catalog.source === 'streaming') {
          const serviceId = catalog.id.replace('streaming.', '');
          currentStreamingServices.add(serviceId);
        }
      });

      // Remove catalogs for services that are no longer selected
      currentStreamingServices.forEach(serviceId => {
        if (!selectedServices.includes(serviceId)) {
          ['movie', 'series'].forEach(type => {
            const catalogId = `streaming.${serviceId}`;

            // Remove from catalogs
            newCatalogs = newCatalogs.filter(c => !(c.id === catalogId && c.type === type));
          });
        }
      });

      // Add catalogs for newly selected services
      selectedServices.forEach(serviceId => {
        if (!currentStreamingServices.has(serviceId)) {
          // Add new catalogs
          ['movie', 'series'].forEach(type => {
            const catalogId = `streaming.${serviceId}`;

            // Add new catalog - always enable when user explicitly adds it
            const def = allCatalogDefinitions.find(c => c.id === catalogId && c.type === type);
            if (def) {
              newCatalogs.push({
                id: def.id,
                name: def.name,
                type: def.type,
                source: def.source,
                enabled: true,
                showInHome: true,
              });
            }
          });
        } else {
          // Enable existing catalogs
          ['movie', 'series'].forEach(type => {
            const catalogId = `streaming.${serviceId}`;
            const existingCatalogIndex = newCatalogs.findIndex(c => c.id === catalogId && c.type === type);
            if (existingCatalogIndex !== -1) {
              console.log('🔗 [Streaming] Enabling existing catalog:', catalogId);
              newCatalogs[existingCatalogIndex] = {
                ...newCatalogs[existingCatalogIndex],
                enabled: true,
                showInHome: true,
              };
            }
          });
        }
      });

      return {
        ...prev,
        streaming: selectedServices,
        catalogs: newCatalogs,
      };
    });
    setStreamingDialogOpen(false);
  };

  const handleReloadCatalogs = () => {
    setConfig(prev => {
      const defaultCatalogs = allCatalogDefinitions.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        source: c.source,
        enabled: c.isEnabledByDefault || false,
        showInHome: c.showOnHomeByDefault || false,
      }));
      const userCatalogSettings = new Map(
        prev.catalogs.map(c => [`${c.id}-${c.type}`, { enabled: c.enabled, showInHome: c.showInHome, enableRatingPosters: c.enableRatingPosters }])
      );
      const userCatalogKeys = new Set(prev.catalogs.map(c => `${c.id}-${c.type}`));
      const missingCatalogs = defaultCatalogs.filter(def => !userCatalogKeys.has(`${def.id}-${def.type}`));
      const mergedCatalogs = [
        ...prev.catalogs,
        ...missingCatalogs
      ];
      const hydratedCatalogs = mergedCatalogs.map(defaultCatalog => {
        const key = `${defaultCatalog.id}-${defaultCatalog.type}`;
        if (userCatalogSettings.has(key)) {
          return { ...defaultCatalog, ...userCatalogSettings.get(key) };
        }
        return defaultCatalog;
      });
      return {
        ...prev,
        catalogs: hydratedCatalogs,
      };
    });
  };

  // Get selected catalogs for bulk actions
  const selectedCatalogs = useMemo(() => {
    return filteredCatalogs.filter(catalog =>
      selectedIds.has(`${catalog.id}-${catalog.type}`)
    );
  }, [filteredCatalogs, selectedIds]);

  // Bulk action handlers
  const handleBulkEnable = async () => {
    setIsLoading(true);
    setLoadingAction('enable');

    try {
      // Filter selected catalogs to only those that can be enabled
      const catalogsToEnable = selectedCatalogs.filter(catalog => {
        // Check if TVDB catalogs have required API key
        if (catalog.source === 'tvdb' && !hasTvdbKey) {
          return false;
        }
        // Only enable catalogs that are currently disabled
        return !catalog.enabled;
      });

      // Count skipped catalogs
      const skippedDueToApiKey = selectedCatalogs.filter(catalog =>
        catalog.source === 'tvdb' && !hasTvdbKey && !catalog.enabled
      ).length;

      // Update config state to enable applicable catalogs
      if (catalogsToEnable.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.map(c => {
            const catalogKey = `${c.id}-${c.type}`;
            const shouldEnable = catalogsToEnable.some(
              cat => `${cat.id}-${cat.type}` === catalogKey
            );
            return shouldEnable ? { ...c, enabled: true } : c;
          })
        }));
      }

      // Show toast notifications using helper
      showBulkEnableSuccess({
        affectedCount: catalogsToEnable.length,
        skippedCount: skippedDueToApiKey,
        skippedReason: skippedDueToApiKey > 0 ? 'missing TVDB API key' : undefined
      });
    } catch (error) {
      showBulkActionError('enable catalogs', error as Error);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  const handleBulkDisable = async () => {
    setIsLoading(true);
    setLoadingAction('disable');

    try {
      // Filter selected catalogs to only those that are currently enabled
      const catalogsToDisable = selectedCatalogs.filter(catalog => catalog.enabled);

      // Update config state to disable applicable catalogs
      if (catalogsToDisable.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.map(c => {
            const catalogKey = `${c.id}-${c.type}`;
            const shouldDisable = catalogsToDisable.some(
              cat => `${cat.id}-${cat.type}` === catalogKey
            );
            // When disabling, also set showInHome to false
            return shouldDisable ? { ...c, enabled: false, showInHome: false } : c;
          })
        }));
      }

      // Show toast notification using helper
      showBulkDisableSuccess({
        affectedCount: catalogsToDisable.length
      });
    } catch (error) {
      showBulkActionError('disable catalogs', error as Error);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  const handleBulkAddToHome = async () => {
    setIsLoading(true);
    setLoadingAction('addToHome');

    try {
      // Filter selected catalogs to only enabled ones
      const catalogsToAddToHome = selectedCatalogs.filter(catalog => catalog.enabled && !catalog.showInHome);

      // Count skipped catalogs (disabled ones)
      const skippedCount = selectedCatalogs.filter(catalog => !catalog.enabled).length;

      // Update config state to set showInHome: true for enabled catalogs
      if (catalogsToAddToHome.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.map(c => {
            const catalogKey = `${c.id}-${c.type}`;
            const shouldAddToHome = catalogsToAddToHome.some(
              cat => `${cat.id}-${cat.type}` === catalogKey
            );
            return shouldAddToHome ? { ...c, showInHome: true } : c;
          })
        }));
      }

      // Show toast notifications using helper
      showBulkAddToHomeSuccess({
        affectedCount: catalogsToAddToHome.length,
        skippedCount: skippedCount
      });
    } catch (error) {
      showBulkActionError('add catalogs to home', error as Error);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  const handleBulkRemoveFromHome = async () => {
    setIsLoading(true);
    setLoadingAction('removeFromHome');

    try {
      // Filter selected catalogs to only those that are currently on home
      const catalogsToRemoveFromHome = selectedCatalogs.filter(catalog => catalog.showInHome);

      // Update config state to set showInHome: false for selected catalogs
      if (catalogsToRemoveFromHome.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.map(c => {
            const catalogKey = `${c.id}-${c.type}`;
            const shouldRemoveFromHome = catalogsToRemoveFromHome.some(
              cat => `${cat.id}-${cat.type}` === catalogKey
            );
            return shouldRemoveFromHome ? { ...c, showInHome: false } : c;
          })
        }));
      }

      // Show toast notification using helper
      showBulkRemoveFromHomeSuccess({
        affectedCount: catalogsToRemoveFromHome.length
      });
    } catch (error) {
      showBulkActionError('remove catalogs from home', error as Error);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  const handleBulkEnableRatingPosters = async () => {
    setIsLoading(true);
    setLoadingAction('enableRatingPosters');

    try {
      // Filter selected catalogs to only those with Rating posters disabled
      const catalogsToEnableRatingPosters = selectedCatalogs.filter(catalog => catalog.enableRatingPosters === false);

      // Update config state to enable RPDB for selected catalogs
      if (catalogsToEnableRatingPosters.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.map(c => {
            const catalogKey = `${c.id}-${c.type}`;
            const shouldEnableRatingPosters = catalogsToEnableRatingPosters.some(
              cat => `${cat.id}-${cat.type}` === catalogKey
            );
            return shouldEnableRatingPosters ? { ...c, enableRatingPosters: true } : c;
          })
        }));
      }

      // Show toast notification
      toast.success(`Rating Posters enabled for ${catalogsToEnableRatingPosters.length} catalog${catalogsToEnableRatingPosters.length === 1 ? '' : 's'}`);
    } catch (error) {
      showBulkActionError('enable Rating Posters', error as Error);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  const handleBulkDisableRatingPosters = async () => {
    setIsLoading(true);
    setLoadingAction('disableRatingPosters');

    try {
      // Filter selected catalogs to only those with Rating posters enabled
      const catalogsToDisableRatingPosters = selectedCatalogs.filter(catalog => catalog.enableRatingPosters !== false);

      // Update config state to disable RPDB for selected catalogs
      if (catalogsToDisableRatingPosters.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.map(c => {
            const catalogKey = `${c.id}-${c.type}`;
            const shouldDisableRatingPosters = catalogsToDisableRatingPosters.some(
              cat => `${cat.id}-${cat.type}` === catalogKey
            );
            return shouldDisableRatingPosters ? { ...c, enableRatingPosters: false } : c;
          })
        }));
      }

      // Show toast notification
      toast.success(`Rating Posters disabled for ${catalogsToDisableRatingPosters.length} catalog${catalogsToDisableRatingPosters.length === 1 ? '' : 's'}`);
    } catch (error) {
      showBulkActionError('disable Rating Posters', error as Error);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  const handleBulkEnableRandomize = async () => {
    setIsLoading(true);
    setLoadingAction('enableRandomize');

    try {
      const catalogsToEnableRandomize = selectedCatalogs.filter(catalog => !catalog.randomizePerPage);

      if (catalogsToEnableRandomize.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.map(c => {
            const catalogKey = `${c.id}-${c.type}`;
            const shouldEnableRandomize = catalogsToEnableRandomize.some(
              cat => `${cat.id}-${cat.type}` === catalogKey
            );
            return shouldEnableRandomize ? { ...c, randomizePerPage: true } : c;
          })
        }));
      }

      toast.success(`Randomize enabled for ${catalogsToEnableRandomize.length} catalog${catalogsToEnableRandomize.length === 1 ? '' : 's'}`);
    } catch (error) {
      showBulkActionError('enable randomize', error as Error);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  const handleBulkDisableRandomize = async () => {
    setIsLoading(true);
    setLoadingAction('disableRandomize');

    try {
      const catalogsToDisableRandomize = selectedCatalogs.filter(catalog => catalog.randomizePerPage);

      if (catalogsToDisableRandomize.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.map(c => {
            const catalogKey = `${c.id}-${c.type}`;
            const shouldDisableRandomize = catalogsToDisableRandomize.some(
              cat => `${cat.id}-${cat.type}` === catalogKey
            );
            return shouldDisableRandomize ? { ...c, randomizePerPage: false } : c;
          })
        }));
      }

      toast.success(`Randomize disabled for ${catalogsToDisableRandomize.length} catalog${catalogsToDisableRandomize.length === 1 ? '' : 's'}`);
    } catch (error) {
      showBulkActionError('disable randomize', error as Error);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  const handleBulkDelete = () => {
    // Show confirmation dialog
    setShowDeleteConfirmDialog(true);
  };

  const handleConfirmBulkDelete = async () => {
    setShowDeleteConfirmDialog(false);
    setIsLoading(true);
    setLoadingAction('delete');

    try {
      // Filter selected catalogs to only removable ones (mdblist, streaming, stremthru, custom)
      const removableSources = ['mdblist', 'streaming', 'stremthru', 'custom'];
      const catalogsToDelete = selectedCatalogs.filter(catalog =>
        removableSources.includes(catalog.source)
      );

      // Count skipped catalogs (non-removable ones)
      const skippedCount = selectedCatalogs.length - catalogsToDelete.length;

      // Remove catalogs from config state
      if (catalogsToDelete.length > 0) {
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.filter(c => {
            const catalogKey = `${c.id}-${c.type}`;
            const shouldDelete = catalogsToDelete.some(
              cat => `${cat.id}-${cat.type}` === catalogKey
            );
            return !shouldDelete;
          })
        }));
      }

      // Show toast notifications using helper
      showBulkDeleteSuccess({
        affectedCount: catalogsToDelete.length,
        skippedCount: skippedCount
      });

      // Clear selection after deletion
      deselectAll();
    } catch (error) {
      showBulkActionError('delete catalogs', error as Error);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  return (
    <div className={cn(
      "space-y-8 animate-fade-in",
      // Add bottom padding on mobile when items are selected to prevent overlap with bottom sheet
      selectionCount > 0 && "pb-[280px] md:pb-0"
    )}>
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold">Catalog Management</h2>
          <p className="text-muted-foreground">
            Drag to reorder. Click icons to toggle visibility.
          </p>
          <div className="flex items-center space-x-6 pt-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <Eye className="h-4 w-4 text-green-500 dark:text-green-400" /> Enabled
            </div>
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <Home className="h-4 w-4 text-blue-500 dark:text-blue-400" /> On Home Board
            </div>
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              {hideDisabledCatalogs ? (
                <EyeOff className="h-4 w-4 text-orange-500 dark:text-orange-400" />
              ) : (
                <Eye className="h-4 w-4 text-muted-foreground" />
              )}
              <button
                onClick={() => setHideDisabledCatalogs(!hideDisabledCatalogs)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {hideDisabledCatalogs ? 'Hide Disabled' : 'Show All'}
              </button>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={handleOpenStreamingDialog} size="sm">
            Manage Streaming Providers
          </Button>
          <Button onClick={() => setIsMdbListOpen(true)} size="sm">
            Manage MDBList Integration
          </Button>
          <Button onClick={() => setIsTraktOpen(true)} size="sm">
            Manage Trakt Integration
          </Button>
          <Button onClick={() => setIsCustomManifestOpen(true)} size="sm">
            Import Custom Manifest
          </Button>
          <MDBListIntegration
            isOpen={isMdbListOpen}
            onClose={() => setIsMdbListOpen(false)}
          />
          <TraktIntegration
            isOpen={isTraktOpen}
            onClose={() => setIsTraktOpen(false)}
          />
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleReloadCatalogs} aria-label="Reload Catalogs">
                  <RefreshCw className="w-5 h-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh catalogs to look for updates</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {/* Bulk Action Bar - shown when items are selected */}
      {selectionCount > 0 && (
        <BulkActionBar
          selectedCatalogs={selectedCatalogs}
          onEnableSelected={handleBulkEnable}
          onDisableSelected={handleBulkDisable}
          onAddToHome={handleBulkAddToHome}
          onRemoveFromHome={handleBulkRemoveFromHome}
          onDeleteSelected={handleBulkDelete}
          onInvertSelection={invertSelection}
          onClearSelection={deselectAll}
          onEnableRatingPosters={handleBulkEnableRatingPosters}
          onDisableRatingPosters={handleBulkDisableRatingPosters}
          onEnableRandomize={handleBulkEnableRandomize}
          onDisableRandomize={handleBulkDisableRandomize}
          hasRatingPostersKey={!!config.apiKeys?.rpdb || !!config.apiKeys?.topPoster}
          isLoading={isLoading}
          loadingAction={loadingAction}
        />
      )}

      {/* Selection Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <SelectAllControl
          totalVisible={filteredCatalogs.length}
          selectedCount={selectionCount}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
        />
        <SelectBySourceControl
          catalogs={filteredCatalogs}
          onSelectBySource={selectBySource}
          onDeselectBySource={deselectBySource}
        />
      </div>

      <div className="relative">
        {/* Loading overlay to prevent interaction during bulk operations */}
        {isLoading && (
          <div
            className="absolute inset-0 bg-background/50 backdrop-blur-sm z-20 cursor-wait"
            aria-hidden="true"
          />
        )}
        
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={catalogItemIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {filteredCatalogs.map((catalog) => (
                <SortableCatalogItem key={`${catalog.id}-${catalog.type}`} catalog={catalog} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
      <StreamingProvidersSettings
        open={streamingDialogOpen}
        onClose={() => setStreamingDialogOpen(false)}
        selectedProviders={tempSelectedProviders}
        setSelectedProviders={setTempSelectedProviders}
        onSave={handleCloseStreamingDialog}
      />
      <MDBListIntegration
        isOpen={isMdbListOpen}
        onClose={() => setIsMdbListOpen(false)}
      />
      <TraktIntegration
        isOpen={isTraktOpen}
        onClose={() => setIsTraktOpen(false)}
      />
      <CustomManifestIntegration
        isOpen={isCustomManifestOpen}
        onClose={() => setIsCustomManifestOpen(false)}
      />

      {/* Bulk Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showDeleteConfirmDialog}
        onClose={() => setShowDeleteConfirmDialog(false)}
        onConfirm={handleConfirmBulkDelete}
        title="Delete Selected Catalogs"
        description={(() => {
          const removableSources = ['mdblist', 'streaming', 'stremthru', 'custom'];
          const catalogsToDelete = selectedCatalogs.filter(catalog =>
            removableSources.includes(catalog.source)
          );
          const skippedCount = selectedCatalogs.length - catalogsToDelete.length;

          let message = `Are you sure you want to delete ${catalogsToDelete.length} catalog${catalogsToDelete.length === 1 ? '' : 's'}?`;

          if (catalogsToDelete.length > 0 && catalogsToDelete.length <= 10) {
            const catalogNames = catalogsToDelete.map(c => `• ${c.name}`).join('\n');
            message += `\n\n${catalogNames}`;
          } else if (catalogsToDelete.length > 10) {
            const firstTen = catalogsToDelete.slice(0, 10).map(c => `• ${c.name}`).join('\n');
            message += `\n\n${firstTen}\n• ...and ${catalogsToDelete.length - 10} more`;
          }

          if (skippedCount > 0) {
            message += `\n\nNote: ${skippedCount} non-removable catalog${skippedCount === 1 ? '' : 's'} will be skipped.`;
          }

          return message;
        })()}
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </div>
  );
}

// Main export component that wraps with SelectionProvider
// ...existing code...

export function CatalogsSettings() {
  const { config, hasBuiltInTvdb, setConfig } = useConfig();
  const [hideDisabledCatalogs, setHideDisabledCatalogs] = useState(config.showDisabledCatalogs ?? false);

  useEffect(() => {
    setHideDisabledCatalogs(config.showDisabledCatalogs ?? false);
  }, [config.showDisabledCatalogs]);

  const handleSetHideDisabled = (value: boolean) => {
    setHideDisabledCatalogs(value);
    setConfig(prev => ({ ...prev, showDisabledCatalogs: value }));
  };

  // Check if TVDB key is available
  const hasTvdbKey = !!config.apiKeys?.tvdb?.trim() || hasBuiltInTvdb;

  // Compute filtered catalogs to pass to SelectionProvider
  const filteredCatalogs = useMemo(() =>
    config.catalogs.filter(cat => {
      // Filter out disabled catalogs if hideDisabledCatalogs is true
      if (hideDisabledCatalogs && !cat.enabled) return false;

      // Filter out TVDB catalogs if no TVDB key is available
      if (cat.source === 'tvdb' && !hasTvdbKey) return false;

      if (cat.source !== "streaming") return true;
      const serviceId = cat.id.replace("streaming.", "").replace(/ .*/, "");
      return Array.isArray(config.streaming) && config.streaming.includes(serviceId);
    }),
    [config.catalogs, config.streaming, hideDisabledCatalogs, hasTvdbKey]
  );

  return (
    <SelectionProvider catalogs={filteredCatalogs}>
      <CatalogsSettingsContent
        hideDisabledCatalogs={hideDisabledCatalogs}
        setHideDisabledCatalogs={handleSetHideDisabled}
      />
    </SelectionProvider>
  );
}