import React, { useState, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MDBListIntegration } from './MDBListIntegration';
import { TraktIntegration } from './TraktIntegration';
import { SimklIntegration } from './SimklIntegration';
import { PublicMetaDBIntegration } from './PublicMetaDBIntegration';
import { TMDBIntegration } from './TMDBIntegration';
import { DiscoverBuilderDialog } from './DiscoverBuilderDialog';
import { LetterboxdIntegration } from './LetterboxdIntegration';
import { AniListIntegration } from './AniListIntegration';
import { CustomManifestIntegration } from './CustomManifestIntegration';
import { StreamingTop10Integration } from './StreamingTop10Integration';
import { AIOMetadataIntegration } from './AIOMetadataIntegration';
import { QuickAddDialog } from '@/components/QuickAddDialog';
import { AICatalogDialog } from '@/components/AICatalogDialog';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Eye, EyeOff, Home, GripVertical, RefreshCw, Trash2, Pencil, Settings, ExternalLink, Star, Shuffle, Link, Wand2, Upload, Download, Trophy, Database, Copy, MoreHorizontal, Sparkles } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose, DialogDescription } from "@/components/ui/dialog";
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
import { SelectByFieldControl } from '@/components/SelectByFieldControl';
import { SelectByTagControl } from '@/components/SelectByTagControl';
import { CatalogTagRow } from '@/components/CatalogTagRow';
import { TagFilterBar } from '@/components/TagFilterBar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CatalogStarterChoice } from '@/components/CatalogStarterChoice';
import {
  showBulkEnableSuccess,
  showBulkDisableSuccess,
  showBulkAddToHomeSuccess,
  showBulkRemoveFromHomeSuccess,
  showBulkDeleteSuccess,
  showBulkActionError
} from '@/utils/toastHelpers';
import { toast } from 'sonner';
import { buildExportPayload, exportToJson, parseImportJson, fetchAndParseUrl, mergeCatalogs, ImportResult } from '@/lib/catalogShare';

interface CustomizeTemplate {
  source: 'tmdb' | 'tvdb' | 'anilist' | 'simkl' | 'mal';
  catalogType: 'movie' | 'series' | 'anime';
  name: string;
  formState: Record<string, any>;
}

const DEFAULT_CATALOG_TEMPLATES: Record<string, (catalog: any) => CustomizeTemplate> = {
  'tmdb.top': (c) => ({
    source: 'tmdb',
    catalogType: c.type,
    name: `${c.name} (Custom)`,
    formState: { 
      sortBy: c.type === 'movie' ? 'primary_release_date.desc' : 'popularity.desc',
      voteCountMin: 50,
    }
  }),
  'tmdb.top_rated': (c) => ({
    source: 'tmdb',
    catalogType: c.type,
    name: `${c.name} (Custom)`,
    formState: { sortBy: 'vote_average.desc', voteCountMin: 500 }
  }),
  'tmdb.airing_today': (c) => ({
    source: 'tmdb',
    catalogType: 'series',
    name: `${c.name} (Custom)`,
    formState: { 
      sortBy: 'popularity.desc',
      airDateFrom: new Date().toISOString().split('T')[0],
      airDateTo: new Date().toISOString().split('T')[0],
    }
  }),
  'tvdb.genres': (c) => ({
    source: 'tvdb',
    catalogType: c.type,
    name: `${c.name} (Custom)`,
    formState: { sortBy: 'score', tvdbSortDirection: 'desc' }
  }),
  'mal.airing': (c) => ({
    source: 'mal',
    catalogType: 'anime',
    name: 'MAL Airing Now (Custom)',
    formState: { sortBy: 'popularity', malStatus: 'airing', malSortDirection: 'desc', malSfw: true }
  }),
  'mal.upcoming': (c) => ({
    source: 'mal',
    catalogType: 'anime',
    name: 'MAL Upcoming (Custom)',
    formState: { sortBy: 'popularity', malStatus: 'upcoming', malSortDirection: 'desc' }
  }),
  'mal.top_anime': (c) => ({
    source: 'mal',
    catalogType: 'anime',
    name: 'MAL Top Anime (Custom)',
    formState: {
      sortBy: 'score',
      malSortDirection: 'desc',
    },
  }),

  'mal.most_popular': (c) => ({
    source: 'mal',
    catalogType: 'anime',
    name: 'MAL Most Popular (Custom)',
    formState: {
      sortBy: 'popularity',
      malSortDirection: 'desc',
    },
  }),

  'mal.most_favorites': (c) => ({
    source: 'mal',
    catalogType: 'anime',
    name: 'MAL Most Favorites (Custom)',
    formState: {
      sortBy: 'favorites',
      malSortDirection: 'desc',
    },
  }),

  'mal.top_movies': (c) => ({
    source: 'mal',
    catalogType: 'anime',
    name: 'MAL Top Movies (Custom)',
    formState: {
      sortBy: 'score',
      malSortDirection: 'desc',
      malType: 'movie',
    },
  }),

  'mal.top_series': (c) => ({
    source: 'mal',
    catalogType: 'anime',
    name: 'MAL Top Series (Custom)',
    formState: {
      sortBy: 'score',
      malSortDirection: 'desc',
      malType: 'tv',
    },
  }),
  'mal.80sDecade': (c) => ({
    source: 'mal',
    catalogType: 'series',
    name: 'MAL Best of 80s (Custom)',
    formState: {
      sortBy: 'score',
      malSortDirection: 'desc',
      malStartDate: '1980-01-01',
      malEndDate: '1989-12-31',
    },
  }),
  'mal.90sDecade': (c) => ({
    source: 'mal',
    catalogType: 'series',
    name: 'MAL Best of 90s (Custom)',
    formState: {
      sortBy: 'score',
      malSortDirection: 'desc',
      malStartDate: '1990-01-01',
      malEndDate: '1999-12-31',
    },
  }),

  'mal.00sDecade': (c) => ({
    source: 'mal',
    catalogType: 'series',
    name: 'MAL Best of 2000s (Custom)',
    formState: {
      sortBy: 'score',
      malSortDirection: 'desc',
      malStartDate: '2000-01-01',
      malEndDate: '2009-12-31',
    },
  }),

  'mal.10sDecade': (c) => ({
    source: 'mal',
    catalogType: 'series',
    name: 'MAL Best of 2010s (Custom)',
    formState: {
      sortBy: 'score',
      malSortDirection: 'desc',
      malStartDate: '2010-01-01',
      malEndDate: '2019-12-31',
    },
  }),

  'mal.20sDecade': (c) => ({
    source: 'mal',
    catalogType: 'series',
    name: 'MAL Best of 2020s (Custom)',
    formState: {
      sortBy: 'score',
      malSortDirection: 'desc',
      malStartDate: '2020-01-01',
      malEndDate: '2029-12-31',
    },
  })
};

type TraktSortOption = 'default' | 'rank' | 'added' | 'title' | 'released' | 'runtime' | 'popularity' | 'random' | 'percentage' | 'imdb_rating' | 'tmdb_rating' | 'rt_tomatometer' | 'rt_audience' | 'metascore' | 'votes' | 'imdb_votes' | 'tmdb_votes' | 'my_rating' | 'watched' | 'collected';
type StreamingSortOption = 'popularity' | 'release_date' | 'vote_average' | 'revenue';
type TMDBSortOption = 'popularity' | 'release_date' | 'vote_average' | 'revenue';
const STREAMING_SORT_OPTIONS: { value: StreamingSortOption; label: string }[] = [
  { value: 'popularity', label: 'Popularity' },
  { value: 'release_date', label: 'Release Date' },
  { value: 'vote_average', label: 'Top Rated' },
  { value: 'revenue', label: 'Revenue' },
];
const TMDB_SORT_OPTIONS: { value: TMDBSortOption; label: string }[] = [
  { value: 'popularity', label: 'Popularity' },
  { value: 'release_date', label: 'Release Date' },
  { value: 'vote_average', label: 'Top Rated' },
  { value: 'revenue', label: 'Revenue' },
];

const TRAKT_SORT_OPTIONS: { value: TraktSortOption; label: string; vip?: boolean }[] = [
  { value: 'default', label: 'Default (Original Order)' },
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

type AniListSortOption = 'MEDIA_ID' | 'SCORE' | 'STATUS' | 'PROGRESS' | 'PROGRESS_VOLUMES' | 'REPEAT' | 'PRIORITY' | 'STARTED_ON' | 'FINISHED_ON' | 'ADDED_TIME' | 'UPDATED_TIME' | 'MEDIA_TITLE_ROMAJI' | 'MEDIA_TITLE_ENGLISH' | 'MEDIA_TITLE_NATIVE' | 'MEDIA_POPULARITY';

const ANILIST_SORT_OPTIONS: { value: AniListSortOption; label: string }[] = [
  { value: 'ADDED_TIME', label: 'Added Time' },
  { value: 'UPDATED_TIME', label: 'Updated Time' },
  { value: 'SCORE', label: 'Score' },
  { value: 'STATUS', label: 'Status' },
  { value: 'PROGRESS', label: 'Progress' },
  { value: 'MEDIA_POPULARITY', label: 'Popularity' },
  { value: 'MEDIA_TITLE_ROMAJI', label: 'Title (Romaji)' },
  { value: 'MEDIA_TITLE_ENGLISH', label: 'Title (English)' },
  { value: 'MEDIA_TITLE_NATIVE', label: 'Title (Native)' },
  { value: 'STARTED_ON', label: 'Started On' },
  { value: 'FINISHED_ON', label: 'Finished On' },
  { value: 'MEDIA_ID', label: 'Media ID' },
  { value: 'PRIORITY', label: 'Priority' },
  { value: 'REPEAT', label: 'Repeat' },
  { value: 'PROGRESS_VOLUMES', label: 'Progress (Volumes)' },
];

function reconcileMergedReferences(catalogs: CatalogConfig[]): CatalogConfig[] {
  const liveIdSet = new Set(catalogs.map(c => `${c.id}-${c.type}`));

  // 1) For each merged catalog, prune dead source refs and decide if it survives.
  type MergedSurvivor = { id: string; sources: NonNullable<NonNullable<CatalogConfig['metadata']>['mergedSources']> };
  const mergedSurvivors = new Map<string, MergedSurvivor>();
  const droppedMergedSources = new Map<string, NonNullable<NonNullable<CatalogConfig['metadata']>['mergedSources']>>();

  let next: CatalogConfig[] = catalogs.map(c => {
    if (c.source !== 'merged') return c;
    const sources = c.metadata?.mergedSources || [];
    const filtered = sources.filter(s => liveIdSet.has(`${s.catalogId}-${s.catalogType}`));
    if (filtered.length >= 2) {
      mergedSurvivors.set(c.id, { id: c.id, sources: filtered });
      return filtered.length === sources.length
        ? c
        : { ...c, metadata: { ...c.metadata, mergedSources: filtered } };
    }
    // Doesn't survive; remember sources so we can restore them in step 3.
    droppedMergedSources.set(c.id, filtered);
    return c;
  });

  // 2) Drop merged catalogs that didn't survive.
  next = next.filter(c => c.source !== 'merged' || mergedSurvivors.has(c.id));

  // 3) Restore originalEnabled/originalShowInHome on sources of dropped merges,
  //    and clear stale mergedInto flags whose target is gone.
  next = next.map(c => {
    if (!c.mergedInto) return c;
    if (mergedSurvivors.has(c.mergedInto)) return c;

    const dropped = droppedMergedSources.get(c.mergedInto);
    const original = dropped?.find(s => s.catalogId === c.id && s.catalogType === c.type);
    const { mergedInto, ...rest } = c;
    if (original) {
      return {
        ...rest,
        enabled: original.originalEnabled,
        showInHome: original.originalShowInHome,
      };
    }
    return rest;
  });

  return next;
}

const sourceBadgeStyles = {
  tmdb: "bg-blue-800/80 text-blue-200 border-blue-600/50 hover:bg-blue-800",
  tvdb: "bg-green-800/80 text-green-200 border-green-600/50 hover:bg-green-800",
  mal: "bg-indigo-800/80 text-indigo-200 border-indigo-600/50 hover:bg-indigo-800",
  tvmaze: "bg-orange-800/80 text-orange-200 border-orange-600/50 hover:bg-orange-800",
  mdblist: "bg-yellow-800/80 text-yellow-200 border-yellow-600/50 hover:bg-yellow-800",
  stremthru: "bg-purple-800/80 text-purple-200 border-purple-600/50 hover:bg-purple-800",
  custom: "bg-pink-800/80 text-pink-200 border-pink-600/50 hover:bg-pink-800",
  trakt: "bg-red-800/80 text-red-200 border-red-600/50 hover:bg-red-800",
  anilist: "bg-cyan-800/80 text-cyan-200 border-cyan-600/50 hover:bg-cyan-800",
  flixpatrol: "bg-emerald-800/80 text-emerald-200 border-emerald-600/50 hover:bg-emerald-800",
  merged: "bg-violet-800/80 text-violet-200 border-violet-600/50 hover:bg-violet-800",
};

const sourceBadgeLabels: Record<string, string> = {
  flixpatrol: 'TOP 10',
};



const MDBListSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, catalogTTL, config } = useConfig();
  const [sort, setSort] = useState<'rank' | 'score' | 'usort' | 'score_average' | 'released' | 'releasedigital' | 'imdbrating' | 'imdbvotes' | 'last_air_date' | 'imdbpopular' | 'tmdbpopular' | 'rogerbert' | 'rtomatoes' | 'rtaudience' | 'metacritic' | 'myanimelist' | 'letterrating' | 'lettervotes' | 'budget' | 'revenue' | 'runtime' | 'title' | 'added' | 'random' | 'default'>((catalog.sort as any) || 'default');
  const [order, setOrder] = useState<'asc' | 'desc'>(catalog.order || 'asc');
  const [cacheTTL, setCacheTTL] = useState<number>(catalog.cacheTTL || catalogTTL);
  const [genreSelection, setGenreSelection] = useState<GenreSelection>(catalog.genreSelection || 'standard');
  const [enableRatingPosters, setEnableRatingPosters] = useState<boolean>(catalog.enableRatingPosters !== false);
  const [filterScoreMin, setFilterScoreMin] = useState<number | undefined>(catalog.filter_score_min);
  const [filterScoreMax, setFilterScoreMax] = useState<number | undefined>(catalog.filter_score_max);
  const [useShowPoster, setUseShowPoster] = useState<boolean>(catalog.metadata?.useShowPosterForUpNext || false);
  const [hideUnreleased, setHideUnreleased] = useState<boolean>(catalog.metadata?.hideUnreleased || false);
  const [hideWatchedTrakt, setHideWatchedTrakt] = useState<string>(catalog.metadata?.hideWatchedTrakt === true ? 'on' : catalog.metadata?.hideWatchedTrakt === false ? 'off' : 'global');
  const [hideWatchedAnilist, setHideWatchedAnilist] = useState<string>(catalog.metadata?.hideWatchedAnilist === true ? 'on' : catalog.metadata?.hideWatchedAnilist === false ? 'off' : 'global');
  const [hideWatchedMdblist, setHideWatchedMdblist] = useState<string>(catalog.metadata?.hideWatchedMdblist === true ? 'on' : catalog.metadata?.hideWatchedMdblist === false ? 'off' : 'global');
  const isUpNext = catalog.id === 'mdblist.upnext';
  const isDiscover = catalog.id.startsWith('mdblist.discover.');
  const showSortOptions = !isUpNext && !isDiscover;

  const handleSave = () => {
    const hideTraktValue = hideWatchedTrakt === 'on' ? true : hideWatchedTrakt === 'off' ? false : undefined;
    const hideAnilistValue = hideWatchedAnilist === 'on' ? true : hideWatchedAnilist === 'off' ? false : undefined;
    const hideMdblistValue = hideWatchedMdblist === 'on' ? true : hideWatchedMdblist === 'off' ? false : undefined;
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ?
          {
            ...c,
            sort,
            order,
            cacheTTL: Math.max(cacheTTL, 300),
            genreSelection,
            enableRatingPosters,
            filter_score_min: filterScoreMin,
            filter_score_max: filterScoreMax,
            metadata: {
              ...c.metadata,
              ...(isUpNext && {
                useShowPosterForUpNext: useShowPoster,
                hideUnreleased
              }),
              hideWatchedTrakt: hideTraktValue,
              hideWatchedAnilist: hideAnilistValue,
              hideWatchedMdblist: hideMdblistValue
            }
          }
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
          {showSortOptions && (
            <>
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
            </>
          )}
          {isUpNext && (
            <>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Use Show Poster</Label>
                  <p className="text-xs text-muted-foreground">Display show poster instead of episode thumbnail</p>
                </div>
                <Switch checked={useShowPoster} onCheckedChange={setUseShowPoster} />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Hide Unreleased Episodes</Label>
                  <p className="text-xs text-muted-foreground">Exclude episodes airing today (appear the next day)</p>
                </div>
                <Switch checked={hideUnreleased} onCheckedChange={setHideUnreleased} />
              </div>
            </>
          )}
          {catalog.source === 'mdblist' && catalog.sourceUrl?.includes('/external/lists/') && (
            <>
              <div className="space-y-2">
                <Label>Minimum Score</Label>
                <Input
                  type="number"
                  value={filterScoreMin ?? ''}
                  onChange={(e) => setFilterScoreMin(e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder="0-100"
                  min="0"
                  max="100"
                />
              </div>
              <div className="space-y-2">
                <Label>Maximum Score</Label>
                <Input
                  type="number"
                  value={filterScoreMax ?? ''}
                  onChange={(e) => setFilterScoreMax(e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder="0-100"
                  min="0"
                  max="100"
                />
              </div>
            </>
          )}
          {isDiscover ? (
            <div className="space-y-2">
              <Label>Cache TTL</Label>
              <p className="text-sm text-muted-foreground">
                Fixed at 6 hours (MDBList caches dynamic catalog results server-side for 6 hours).
              </p>
            </div>
          ) : (
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
          )}
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
          {(config.apiKeys?.rpdb || config.apiKeys?.topPoster || config.customPosterUrlPattern) && (
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
          {config.apiKeys?.traktTokenId && (
            <div className="space-y-2">
              <Label>Hide Trakt Watched</Label>
              <Select value={hideWatchedTrakt} onValueChange={setHideWatchedTrakt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.anilistTokenId && (
            <div className="space-y-2">
              <Label>Hide AniList Watched</Label>
              <Select value={hideWatchedAnilist} onValueChange={setHideWatchedAnilist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.mdblist && (
            <div className="space-y-2">
              <Label>Hide MDBList Watched</Label>
              <Select value={hideWatchedMdblist} onValueChange={setHideWatchedMdblist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
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
  const { setConfig, catalogTTL, config } = useConfig();
  const [sort, setSort] = useState<TraktSortOption>(catalog.sort as TraktSortOption || 'default');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(catalog.sortDirection as 'asc' | 'desc' || 'asc');
  const [cacheTTL, setCacheTTL] = useState<number>(catalog.cacheTTL || catalogTTL);
  const [useShowPoster, setUseShowPoster] = useState<boolean>(catalog.metadata?.useShowPosterForUpNext || false);
  const [hideWatchedTrakt, setHideWatchedTrakt] = useState<string>(catalog.metadata?.hideWatchedTrakt === true ? 'on' : catalog.metadata?.hideWatchedTrakt === false ? 'off' : 'global');
  const [hideWatchedAnilist, setHideWatchedAnilist] = useState<string>(catalog.metadata?.hideWatchedAnilist === true ? 'on' : catalog.metadata?.hideWatchedAnilist === false ? 'off' : 'global');
  const [hideWatchedMdblist, setHideWatchedMdblist] = useState<string>(catalog.metadata?.hideWatchedMdblist === true ? 'on' : catalog.metadata?.hideWatchedMdblist === false ? 'off' : 'global');
  const [airingSoonDays, setAiringSoonDays] = useState<number>(() => {
    const days = catalog.metadata?.airingSoonDays;
    if (typeof days === 'number' && days >= 1 && days <= 7) {
      return days;
    }
    return 1;
  });
  
  const minCacheTTL = 300; // 5 minutes minimum for all Trakt catalogs
  const isUpNext = catalog.id === 'trakt.upnext';
  const isCalendar = catalog.id === 'trakt.calendar';
  const showSortOptions = !catalog.id.startsWith('trakt.trending.') && !catalog.id.startsWith('trakt.popular.') && !catalog.id.startsWith('trakt.anticipated.') && catalog.id !== 'trakt.upnext';

  const handleSave = () => {
    const hideTraktValue = hideWatchedTrakt === 'on' ? true : hideWatchedTrakt === 'off' ? false : undefined;
    const hideAnilistValue = hideWatchedAnilist === 'on' ? true : hideWatchedAnilist === 'off' ? false : undefined;
    const hideMdblistValue = hideWatchedMdblist === 'on' ? true : hideWatchedMdblist === 'off' ? false : undefined;
    setConfig(prev => {
      const updatedCatalogs = prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? {
              ...c,
              sort,
              sortDirection,
              cacheTTL: Math.max(cacheTTL, minCacheTTL),
              metadata: {
                ...c.metadata,
                ...(isUpNext && { useShowPosterForUpNext: useShowPoster }),
                ...(isCalendar && {
                  airingSoonDays: Math.max(1, Math.min(7, airingSoonDays))
                }),
                hideWatchedTrakt: hideTraktValue,
                hideWatchedAnilist: hideAnilistValue,
                hideWatchedMdblist: hideMdblistValue
              }
            }
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
          {showSortOptions && (
            <>
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
                                  <span role="img" aria-label="VIP" className="ml-1">ðŸ’Ž</span>
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
            </>
          )}

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

          {isUpNext && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Use Show Poster</Label>
                  <p className="text-xs text-muted-foreground">
                    Display show poster instead of episode thumbnail
                  </p>
                </div>
                <Switch
                  checked={useShowPoster}
                  onCheckedChange={setUseShowPoster}
                />
              </div>
            </div>
          )}

          {isCalendar && (
            <div className="space-y-2">
              <Label>Days Ahead</Label>
              <Select value={airingSoonDays.toString()} onValueChange={(value) => setAiringSoonDays(Number(value))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 7].map(days => (
                    <SelectItem key={days} value={days.toString()}>
                      {days} {days === 1 ? 'day' : 'days'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Shows airing within the selected number of days
              </p>
            </div>
          )}
          {config.apiKeys?.traktTokenId && (
            <div className="space-y-2">
              <Label>Hide Trakt Watched</Label>
              <Select value={hideWatchedTrakt} onValueChange={setHideWatchedTrakt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.anilistTokenId && (
            <div className="space-y-2">
              <Label>Hide AniList Watched</Label>
              <Select value={hideWatchedAnilist} onValueChange={setHideWatchedAnilist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.mdblist && (
            <div className="space-y-2">
              <Label>Hide MDBList Watched</Label>
              <Select value={hideWatchedMdblist} onValueChange={setHideWatchedMdblist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
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

const SimklSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, catalogTTL, config } = useConfig();
  const [cacheTTL, setCacheTTL] = useState<number>(catalog.cacheTTL || catalogTTL);
  const isTrending = catalog.id.startsWith('simkl.trending.');
  const isWatchlist = catalog.id.startsWith('simkl.watchlist.');
  const isCalendar = catalog.id.startsWith('simkl.calendar');
  const [pageSize, setPageSize] = useState<number>(catalog.metadata?.pageSize || 50);
  const [hideWatchedTrakt, setHideWatchedTrakt] = useState<string>(catalog.metadata?.hideWatchedTrakt === true ? 'on' : catalog.metadata?.hideWatchedTrakt === false ? 'off' : 'global');
  const [hideWatchedAnilist, setHideWatchedAnilist] = useState<string>(catalog.metadata?.hideWatchedAnilist === true ? 'on' : catalog.metadata?.hideWatchedAnilist === false ? 'off' : 'global');
  const [hideWatchedMdblist, setHideWatchedMdblist] = useState<string>(catalog.metadata?.hideWatchedMdblist === true ? 'on' : catalog.metadata?.hideWatchedMdblist === false ? 'off' : 'global');
  const [airingSoonDays, setAiringSoonDays] = useState<number>(() => {
    const days = catalog.metadata?.airingSoonDays;
    if (typeof days === 'number' && days >= 1 && days <= 7) {
      return days;
    }
    return 1;
  });
  
  const minCacheTTL = isTrending ? 3600 : 300;

  const handleSave = () => {
    const hideTraktValue = hideWatchedTrakt === 'on' ? true : hideWatchedTrakt === 'off' ? false : undefined;
    const hideAnilistValue = hideWatchedAnilist === 'on' ? true : hideWatchedAnilist === 'off' ? false : undefined;
    const hideMdblistValue = hideWatchedMdblist === 'on' ? true : hideWatchedMdblist === 'off' ? false : undefined;
    setConfig(prev => {
      const updatedCatalogs = prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? {
              ...c,
              cacheTTL: Math.max(cacheTTL, minCacheTTL),
              metadata: {
                ...c.metadata,
                // Only include pageSize for trending (watchlists use local pagination)
                ...(isTrending && { pageSize: Math.max(1, pageSize) || 50 }),
                // Remove pageSize from watchlists if it exists
                ...(isWatchlist && catalog.metadata?.pageSize && { pageSize: undefined }),
                // Airing soon days
                ...(isCalendar && { airingSoonDays: Math.max(1, Math.min(7, airingSoonDays)) }),
                hideWatchedTrakt: hideTraktValue,
                hideWatchedAnilist: hideAnilistValue,
                hideWatchedMdblist: hideMdblistValue
              }
            }
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
          <DialogTitle>Simkl Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {!isWatchlist && (
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
          )}
          
          {isTrending && (
            <div className="space-y-2">
              <Label>Results Per Page</Label>
              <Select
                value={pageSize.toString()}
                onValueChange={(value) => setPageSize(Number(value))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(() => {
                    const options = (config.apiKeys as any)?.simklTrendingPageSizeOptions || [50, 100];
                    const optionsWithCurrent = options.includes(pageSize)
                      ? options
                      : [...options, pageSize].sort((a, b) => a - b);
                    return optionsWithCurrent.map((n) => (
                      <SelectItem key={n} value={n.toString()}>
                        {n}
                      </SelectItem>
                    ));
                  })()}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Number of results to fetch per page from Simkl API for trending catalogs (default: 50). Watchlists use local pagination. 
                <strong> Must match the value in your SimKL settings.</strong>
              </p>
            </div>
          )}

          {isCalendar && (
            <div className="space-y-2">
              <Label>Days Ahead</Label>
              <Select value={airingSoonDays.toString()} onValueChange={(value) => setAiringSoonDays(Number(value))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 7].map(days => (
                    <SelectItem key={days} value={days.toString()}>
                      {days} {days === 1 ? 'day' : 'days'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Shows airing within the selected number of days
              </p>
            </div>
          )}
          {config.apiKeys?.traktTokenId && (
            <div className="space-y-2">
              <Label>Hide Trakt Watched</Label>
              <Select value={hideWatchedTrakt} onValueChange={setHideWatchedTrakt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.anilistTokenId && (
            <div className="space-y-2">
              <Label>Hide AniList Watched</Label>
              <Select value={hideWatchedAnilist} onValueChange={setHideWatchedAnilist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.mdblist && (
            <div className="space-y-2">
              <Label>Hide MDBList Watched</Label>
              <Select value={hideWatchedMdblist} onValueChange={setHideWatchedMdblist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
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

const LetterboxdSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, catalogTTL, config } = useConfig();
  const [cacheTTL, setCacheTTL] = useState<number>(catalog.cacheTTL || catalogTTL);
  const [enableRatingPosters, setEnableRatingPosters] = useState<boolean>(catalog.enableRatingPosters !== false);
  const [hideWatchedTrakt, setHideWatchedTrakt] = useState<string>(catalog.metadata?.hideWatchedTrakt === true ? 'on' : catalog.metadata?.hideWatchedTrakt === false ? 'off' : 'global');
  const [hideWatchedAnilist, setHideWatchedAnilist] = useState<string>(catalog.metadata?.hideWatchedAnilist === true ? 'on' : catalog.metadata?.hideWatchedAnilist === false ? 'off' : 'global');
  const [hideWatchedMdblist, setHideWatchedMdblist] = useState<string>(catalog.metadata?.hideWatchedMdblist === true ? 'on' : catalog.metadata?.hideWatchedMdblist === false ? 'off' : 'global');

  const handleSave = () => {
    const hideTraktValue = hideWatchedTrakt === 'on' ? true : hideWatchedTrakt === 'off' ? false : undefined;
    const hideAnilistValue = hideWatchedAnilist === 'on' ? true : hideWatchedAnilist === 'off' ? false : undefined;
    const hideMdblistValue = hideWatchedMdblist === 'on' ? true : hideWatchedMdblist === 'off' ? false : undefined;
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? { ...c, cacheTTL: Math.max(cacheTTL, 7200), enableRatingPosters, metadata: { ...c.metadata, hideWatchedTrakt: hideTraktValue, hideWatchedAnilist: hideAnilistValue, hideWatchedMdblist: hideMdblistValue } }
          : c
      )
    }));
    onClose();
  };
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Letterboxd Catalog Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="letterboxd-cache-ttl">Cache TTL (seconds)</Label>
            <Input
              id="letterboxd-cache-ttl"
              type="number"
              value={cacheTTL}
              onChange={(e) => setCacheTTL(parseInt(e.target.value) || catalogTTL)}
              min="7200"
              max="604800"
              step="3600"
              className="flex-1 px-3 py-2 border border-input bg-background rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              placeholder={catalogTTL.toString()}
            />
            <p className="text-xs text-muted-foreground">
              How long to cache this catalog before refreshing. Range: 2 hours to 7 days.
            </p>
          </div>
          {(config.apiKeys?.rpdb || config.apiKeys?.topPoster || config.customPosterUrlPattern) && (
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
          {config.apiKeys?.traktTokenId && (
            <div className="space-y-2">
              <Label>Hide Trakt Watched</Label>
              <Select value={hideWatchedTrakt} onValueChange={setHideWatchedTrakt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.anilistTokenId && (
            <div className="space-y-2">
              <Label>Hide AniList Watched</Label>
              <Select value={hideWatchedAnilist} onValueChange={setHideWatchedAnilist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.mdblist && (
            <div className="space-y-2">
              <Label>Hide MDBList Watched</Label>
              <Select value={hideWatchedMdblist} onValueChange={setHideWatchedMdblist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
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

const TMDBSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, catalogTTL, config } = useConfig();

  const validTMDBSorts: TMDBSortOption[] = ['popularity', 'release_date', 'vote_average', 'revenue'];
  const initialSort = validTMDBSorts.includes(catalog.sort as TMDBSortOption)
    ? (catalog.sort as TMDBSortOption)
    : 'popularity';

  const [sort, setSort] = useState<TMDBSortOption>(initialSort);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>((catalog.sortDirection as 'asc' | 'desc') || 'desc');
  const [hideWatchedTrakt, setHideWatchedTrakt] = useState<string>(catalog.metadata?.hideWatchedTrakt === true ? 'on' : catalog.metadata?.hideWatchedTrakt === false ? 'off' : 'global');
  const [hideWatchedAnilist, setHideWatchedAnilist] = useState<string>(catalog.metadata?.hideWatchedAnilist === true ? 'on' : catalog.metadata?.hideWatchedAnilist === false ? 'off' : 'global');
  const [hideWatchedMdblist, setHideWatchedMdblist] = useState<string>(catalog.metadata?.hideWatchedMdblist === true ? 'on' : catalog.metadata?.hideWatchedMdblist === false ? 'off' : 'global');

  const handleSave = () => {
    const hideTraktValue = hideWatchedTrakt === 'on' ? true : hideWatchedTrakt === 'off' ? false : undefined;
    const hideAnilistValue = hideWatchedAnilist === 'on' ? true : hideWatchedAnilist === 'off' ? false : undefined;
    const hideMdblistValue = hideWatchedMdblist === 'on' ? true : hideWatchedMdblist === 'off' ? false : undefined;
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? { ...c, sort, sortDirection, metadata: { ...c.metadata, hideWatchedTrakt: hideTraktValue, hideWatchedAnilist: hideAnilistValue, hideWatchedMdblist: hideMdblistValue } }
          : c
      )
    }));
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>TMDB Catalog Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Sort By</Label>
            <Select value={sort} onValueChange={(value) => setSort(value as TMDBSortOption)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TMDB_SORT_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
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
                <SelectItem value="desc">Descending</SelectItem>
                <SelectItem value="asc">Ascending</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {config.apiKeys?.traktTokenId && (
            <div className="space-y-2">
              <Label>Hide Trakt Watched</Label>
              <Select value={hideWatchedTrakt} onValueChange={setHideWatchedTrakt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.anilistTokenId && (
            <div className="space-y-2">
              <Label>Hide AniList Watched</Label>
              <Select value={hideWatchedAnilist} onValueChange={setHideWatchedAnilist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.mdblist && (
            <div className="space-y-2">
              <Label>Hide MDBList Watched</Label>
              <Select value={hideWatchedMdblist} onValueChange={setHideWatchedMdblist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
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
  const [hideWatchedTrakt, setHideWatchedTrakt] = useState<string>(catalog.metadata?.hideWatchedTrakt === true ? 'on' : catalog.metadata?.hideWatchedTrakt === false ? 'off' : 'global');
  const [hideWatchedAnilist, setHideWatchedAnilist] = useState<string>(catalog.metadata?.hideWatchedAnilist === true ? 'on' : catalog.metadata?.hideWatchedAnilist === false ? 'off' : 'global');
  const [hideWatchedMdblist, setHideWatchedMdblist] = useState<string>(catalog.metadata?.hideWatchedMdblist === true ? 'on' : catalog.metadata?.hideWatchedMdblist === false ? 'off' : 'global');

  const handleSave = () => {
    const hideTraktValue = hideWatchedTrakt === 'on' ? true : hideWatchedTrakt === 'off' ? false : undefined;
    const hideAnilistValue = hideWatchedAnilist === 'on' ? true : hideWatchedAnilist === 'off' ? false : undefined;
    const hideMdblistValue = hideWatchedMdblist === 'on' ? true : hideWatchedMdblist === 'off' ? false : undefined;
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? { ...c, cacheTTL: Math.max(cacheTTL, 300), enableRatingPosters, metadata: { ...c.metadata, hideWatchedTrakt: hideTraktValue, hideWatchedAnilist: hideAnilistValue, hideWatchedMdblist: hideMdblistValue } }
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
          {(config.apiKeys?.rpdb || config.apiKeys?.topPoster || config.customPosterUrlPattern) && (
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
          {config.apiKeys?.traktTokenId && (
            <div className="space-y-2">
              <Label>Hide Trakt Watched</Label>
              <Select value={hideWatchedTrakt} onValueChange={setHideWatchedTrakt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.anilistTokenId && (
            <div className="space-y-2">
              <Label>Hide AniList Watched</Label>
              <Select value={hideWatchedAnilist} onValueChange={setHideWatchedAnilist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.mdblist && (
            <div className="space-y-2">
              <Label>Hide MDBList Watched</Label>
              <Select value={hideWatchedMdblist} onValueChange={setHideWatchedMdblist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
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

const AniListSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, catalogTTL, config } = useConfig();
  const [sort, setSort] = useState<AniListSortOption>(catalog.sort as AniListSortOption || 'ADDED_TIME');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(catalog.sortDirection as 'asc' | 'desc' || 'desc');
  const [cacheTTL, setCacheTTL] = useState<number>(catalog.cacheTTL || catalogTTL);
  const [hideWatchedTrakt, setHideWatchedTrakt] = useState<string>(catalog.metadata?.hideWatchedTrakt === true ? 'on' : catalog.metadata?.hideWatchedTrakt === false ? 'off' : 'global');
  const [hideWatchedAnilist, setHideWatchedAnilist] = useState<string>(catalog.metadata?.hideWatchedAnilist === true ? 'on' : catalog.metadata?.hideWatchedAnilist === false ? 'off' : 'global');
  const [hideWatchedMdblist, setHideWatchedMdblist] = useState<string>(catalog.metadata?.hideWatchedMdblist === true ? 'on' : catalog.metadata?.hideWatchedMdblist === false ? 'off' : 'global');

  const handleSave = () => {
    const hideTraktValue = hideWatchedTrakt === 'on' ? true : hideWatchedTrakt === 'off' ? false : undefined;
    const hideAnilistValue = hideWatchedAnilist === 'on' ? true : hideWatchedAnilist === 'off' ? false : undefined;
    const hideMdblistValue = hideWatchedMdblist === 'on' ? true : hideWatchedMdblist === 'off' ? false : undefined;
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? { ...c, sort, sortDirection, cacheTTL: Math.max(cacheTTL, 300), metadata: { ...c.metadata, hideWatchedTrakt: hideTraktValue, hideWatchedAnilist: hideAnilistValue, hideWatchedMdblist: hideMdblistValue } }
          : c
      )
    }));
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>AniList Catalog Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Sort By</Label>
            <Select value={sort} onValueChange={(value) => setSort(value as AniListSortOption)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANILIST_SORT_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
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
            <Label htmlFor="anilist-cache-ttl">Cache TTL (seconds)</Label>
            <div className="flex items-center space-x-2">
              <input
                id="anilist-cache-ttl"
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
          {config.apiKeys?.traktTokenId && (
            <div className="space-y-2">
              <Label>Hide Trakt Watched</Label>
              <Select value={hideWatchedTrakt} onValueChange={setHideWatchedTrakt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.anilistTokenId && (
            <div className="space-y-2">
              <Label>Hide AniList Watched</Label>
              <Select value={hideWatchedAnilist} onValueChange={setHideWatchedAnilist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.mdblist && (
            <div className="space-y-2">
              <Label>Hide MDBList Watched</Label>
              <Select value={hideWatchedMdblist} onValueChange={setHideWatchedMdblist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
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

const StreamingSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, catalogTTL, config } = useConfig();

  const validStreamingSorts: StreamingSortOption[] = ['popularity', 'release_date', 'vote_average', 'revenue'];
  const initialSort = validStreamingSorts.includes(catalog.sort as StreamingSortOption)
    ? (catalog.sort as StreamingSortOption)
    : 'popularity';

  const [sort, setSort] = useState<StreamingSortOption>(initialSort);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>((catalog.sortDirection as 'asc' | 'desc') || 'desc');
  const [hideWatchedTrakt, setHideWatchedTrakt] = useState<string>(catalog.metadata?.hideWatchedTrakt === true ? 'on' : catalog.metadata?.hideWatchedTrakt === false ? 'off' : 'global');
  const [hideWatchedAnilist, setHideWatchedAnilist] = useState<string>(catalog.metadata?.hideWatchedAnilist === true ? 'on' : catalog.metadata?.hideWatchedAnilist === false ? 'off' : 'global');
  const [hideWatchedMdblist, setHideWatchedMdblist] = useState<string>(catalog.metadata?.hideWatchedMdblist === true ? 'on' : catalog.metadata?.hideWatchedMdblist === false ? 'off' : 'global');

  const handleSave = () => {
    const hideTraktValue = hideWatchedTrakt === 'on' ? true : hideWatchedTrakt === 'off' ? false : undefined;
    const hideAnilistValue = hideWatchedAnilist === 'on' ? true : hideWatchedAnilist === 'off' ? false : undefined;
    const hideMdblistValue = hideWatchedMdblist === 'on' ? true : hideWatchedMdblist === 'off' ? false : undefined;
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? { ...c, sort, sortDirection, metadata: { ...c.metadata, hideWatchedTrakt: hideTraktValue, hideWatchedAnilist: hideAnilistValue, hideWatchedMdblist: hideMdblistValue } }
          : c
      )
    }));
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Streaming Catalog Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Sort By</Label>
            <Select value={sort} onValueChange={(value) => setSort(value as StreamingSortOption)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STREAMING_SORT_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
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
                <SelectItem value="desc">Descending</SelectItem>
                <SelectItem value="asc">Ascending</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {config.apiKeys?.traktTokenId && (
            <div className="space-y-2">
              <Label>Hide Trakt Watched</Label>
              <Select value={hideWatchedTrakt} onValueChange={setHideWatchedTrakt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.anilistTokenId && (
            <div className="space-y-2">
              <Label>Hide AniList Watched</Label>
              <Select value={hideWatchedAnilist} onValueChange={setHideWatchedAnilist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.mdblist && (
            <div className="space-y-2">
              <Label>Hide MDBList Watched</Label>
              <Select value={hideWatchedMdblist} onValueChange={setHideWatchedMdblist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
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

const PMDBSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, catalogTTL, config } = useConfig();
  const isWatchlist = catalog.id === 'publicmetadb.upnext';
  const minCacheTTL = isWatchlist ? 900 : 10800;
  const defaultTTL = isWatchlist ? 900 : Math.max(catalogTTL, minCacheTTL);
  const [cacheTTL, setCacheTTL] = useState<number>(catalog.cacheTTL || defaultTTL);
  const [hideWatchedTrakt, setHideWatchedTrakt] = useState<string>(catalog.metadata?.hideWatchedTrakt === true ? 'on' : catalog.metadata?.hideWatchedTrakt === false ? 'off' : 'global');
  const [hideWatchedAnilist, setHideWatchedAnilist] = useState<string>(catalog.metadata?.hideWatchedAnilist === true ? 'on' : catalog.metadata?.hideWatchedAnilist === false ? 'off' : 'global');
  const [hideWatchedMdblist, setHideWatchedMdblist] = useState<string>(catalog.metadata?.hideWatchedMdblist === true ? 'on' : catalog.metadata?.hideWatchedMdblist === false ? 'off' : 'global');

  const handleSave = () => {
    const hideTraktValue = hideWatchedTrakt === 'on' ? true : hideWatchedTrakt === 'off' ? false : undefined;
    const hideAnilistValue = hideWatchedAnilist === 'on' ? true : hideWatchedAnilist === 'off' ? false : undefined;
    const hideMdblistValue = hideWatchedMdblist === 'on' ? true : hideWatchedMdblist === 'off' ? false : undefined;
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? { ...c, cacheTTL: Math.max(cacheTTL, minCacheTTL), metadata: { ...c.metadata, hideWatchedTrakt: hideTraktValue, hideWatchedAnilist: hideAnilistValue, hideWatchedMdblist: hideMdblistValue } }
          : c
      )
    }));
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>PMDB Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Cache TTL (seconds)</Label>
            <div className="flex items-center space-x-2">
              <input
                type="number"
                value={cacheTTL}
                onChange={(e) => setCacheTTL(parseInt(e.target.value) || catalogTTL)}
                min={minCacheTTL}
                max="604800"
                step={isWatchlist ? 900 : 3600}
                className="flex-1 px-3 py-2 border border-input bg-background rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                placeholder={catalogTTL.toString()}
              />
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                ({Math.floor(cacheTTL / 3600)}h {Math.floor((cacheTTL % 3600) / 60)}m)
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {isWatchlist
                ? 'Minimum 15 minutes for watchlist. Range: 15 minutes to 7 days.'
                : 'Minimum 3 hours for lists and picks. Range: 3 hours to 7 days.'}
            </p>
          </div>
          {config.apiKeys?.traktTokenId && (
            <div className="space-y-2">
              <Label>Hide Trakt Watched</Label>
              <Select value={hideWatchedTrakt} onValueChange={setHideWatchedTrakt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.anilistTokenId && (
            <div className="space-y-2">
              <Label>Hide AniList Watched</Label>
              <Select value={hideWatchedAnilist} onValueChange={setHideWatchedAnilist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.mdblist && (
            <div className="space-y-2">
              <Label>Hide MDBList Watched</Label>
              <Select value={hideWatchedMdblist} onValueChange={setHideWatchedMdblist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
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

const GenericSettingsDialog = ({ catalog, isOpen, onClose }: { catalog: CatalogConfig, isOpen: boolean, onClose: () => void }) => {
  const { setConfig, config } = useConfig();
  const [hideWatchedTrakt, setHideWatchedTrakt] = useState<string>(catalog.metadata?.hideWatchedTrakt === true ? 'on' : catalog.metadata?.hideWatchedTrakt === false ? 'off' : 'global');
  const [hideWatchedAnilist, setHideWatchedAnilist] = useState<string>(catalog.metadata?.hideWatchedAnilist === true ? 'on' : catalog.metadata?.hideWatchedAnilist === false ? 'off' : 'global');
  const [hideWatchedMdblist, setHideWatchedMdblist] = useState<string>(catalog.metadata?.hideWatchedMdblist === true ? 'on' : catalog.metadata?.hideWatchedMdblist === false ? 'off' : 'global');

  const handleSave = () => {
    const hideTraktValue = hideWatchedTrakt === 'on' ? true : hideWatchedTrakt === 'off' ? false : undefined;
    const hideAnilistValue = hideWatchedAnilist === 'on' ? true : hideWatchedAnilist === 'off' ? false : undefined;
    const hideMdblistValue = hideWatchedMdblist === 'on' ? true : hideWatchedMdblist === 'off' ? false : undefined;
    
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        c.id === catalog.id && c.type === catalog.type
          ? { ...c, metadata: { ...c.metadata, hideWatchedTrakt: hideTraktValue, hideWatchedAnilist: hideAnilistValue, hideWatchedMdblist: hideMdblistValue } }
          : c
      )
    }));
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{catalog.name} Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {config.apiKeys?.traktTokenId && (
            <div className="space-y-2">
              <Label>Hide Trakt Watched</Label>
              <Select value={hideWatchedTrakt} onValueChange={setHideWatchedTrakt}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.anilistTokenId && (
            <div className="space-y-2">
              <Label>Hide AniList Watched</Label>
              <Select value={hideWatchedAnilist} onValueChange={setHideWatchedAnilist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {config.apiKeys?.mdblist && (
            <div className="space-y-2">
              <Label>Hide MDBList Watched</Label>
              <Select value={hideWatchedMdblist} onValueChange={setHideWatchedMdblist}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Use Global Setting</SelectItem>
                  <SelectItem value="on">Always On</SelectItem>
                  <SelectItem value="off">Always Off</SelectItem>
                </SelectContent>
              </Select>
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

import { Layers, GitMerge, Unlink } from 'lucide-react';

const MergedCatalogCard = ({
  catalog,
  allCatalogs,
  onDisband,
}: {
  catalog: CatalogConfig;
  allCatalogs: CatalogConfig[];
  onDisband: () => void;
}) => {
  const { setConfig, config } = useConfig();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${catalog.id}-${catalog.type}`,
  });
  const { toggleSelection, isSelected, selectionCount } = useSelection();
  const catalogKey = `${catalog.id}-${catalog.type}`;
  const selected = isSelected(catalogKey);

  const sources = catalog.metadata?.mergedSources || [];
  const sourceCatalogs = sources
    .map(s => allCatalogs.find(c => c.id === s.catalogId && c.type === s.catalogType))
    .filter(Boolean) as CatalogConfig[];

  const [expanded, setExpanded] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [newName, setNewName] = useState(catalog.name);
  const [newType, setNewType] = useState(catalog.displayType || catalog.type);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsMergeMode, setSettingsMergeMode] = useState<'interleaved' | 'sequential' | 'alternating'>(catalog.metadata?.mergeMode || 'interleaved');

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 'auto',
  };

  const updateCatalog = (updater: (c: CatalogConfig) => CatalogConfig) => {
    setConfig(prev => ({
      ...prev,
      catalogs: prev.catalogs.map(c =>
        (c.id === catalog.id && c.type === catalog.type) ? updater(c) : c
      ),
    }));
  };

  const handleToggleEnabled = () => {
    updateCatalog(c => {
      const isNowEnabled = !c.enabled;
      return { ...c, enabled: isNowEnabled, showInHome: isNowEnabled ? c.showInHome : false };
    });
  };

  const handleToggleShowInHome = () => {
    if (!catalog.enabled) return;
    updateCatalog(c => ({ ...c, showInHome: !c.showInHome }));
  };

  const handleToggleRatingPosters = () => {
    updateCatalog(c => ({ ...c, enableRatingPosters: c.enableRatingPosters === false ? true : false }));
  };

  const handleToggleRandomize = () => {
    updateCatalog(c => ({ ...c, randomizePerPage: !c.randomizePerPage }));
  };

  const handleEditSave = () => {
    const trimmedName = newName.trim();
    const trimmedType = newType.trim();
    if (!trimmedName || !trimmedType) {
      setNewName(catalog.name);
      setNewType(catalog.displayType || catalog.type);
      setShowEditDialog(false);
      return;
    }
    updateCatalog(c => ({ ...c, name: trimmedName, displayType: trimmedType }));
    setShowEditDialog(false);
  };

  const handleEditCancel = () => {
    setNewName(catalog.name);
    setNewType(catalog.displayType || catalog.type);
    setShowEditDialog(false);
  };

  const handleMoveToTop = () => {
    setConfig(prev => {
      const idx = prev.catalogs.findIndex(c => c.id === catalog.id && c.type === catalog.type);
      if (idx <= 0) return prev;
      const next = [...prev.catalogs];
      const [moved] = next.splice(idx, 1);
      next.unshift(moved);
      return { ...prev, catalogs: next };
    });
  };

  const handleMoveToBottom = () => {
    setConfig(prev => {
      const idx = prev.catalogs.findIndex(c => c.id === catalog.id && c.type === catalog.type);
      if (idx === -1 || idx === prev.catalogs.length - 1) return prev;
      const next = [...prev.catalogs];
      const [moved] = next.splice(idx, 1);
      next.push(moved);
      return { ...prev, catalogs: next };
    });
  };

  const hasRatingPosters = !!(config.apiKeys?.rpdb || config.apiKeys?.topPoster || config.customPosterUrlPattern);

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative flex flex-col p-4",
        "border-violet-600/40 bg-violet-950/10 dark:bg-violet-950/20",
        "transition-all duration-200 ease-out",
        isDragging && "opacity-80 scale-[1.02] shadow-2xl ring-2 ring-violet-500/50",
        !isDragging && "hover:-translate-y-[1px] hover:shadow-md",
        !catalog.enabled && "opacity-60",
        selected && "ring-2 ring-blue-500"
      )}
    >
      {isDragging && selected && selectionCount > 1 && (
        <div className="absolute -top-3 -right-3 z-[60] animate-in zoom-in duration-200">
          <Badge className="bg-blue-600 text-white shadow-xl px-3 py-1 flex items-center gap-1.5 border-2 border-background">
            <Layers className="h-3.5 w-3.5" />
            <span className="font-bold">Moving {selectionCount} items</span>
          </Badge>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap md:flex-nowrap">
        <div
          onClick={(e) => { e.stopPropagation(); toggleSelection(catalogKey); }}
          className="cursor-pointer p-2 -ml-2 min-w-[40px] min-h-[40px] md:min-w-0 md:min-h-0 flex items-center"
          role="checkbox"
          aria-checked={selected}
          aria-label="Select merged catalog"
        >
          <div className={cn(
            "w-5 h-5 border-2 rounded flex items-center justify-center transition-all duration-200 ease-out",
            selected
              ? "bg-blue-600 border-blue-600 dark:bg-blue-500 dark:border-blue-500"
              : "border-gray-400 dark:border-gray-600 hover:border-blue-500 dark:hover:border-blue-400"
          )}>
            {selected && (
              <svg
                className="w-3.5 h-3.5 text-white"
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

        <button
          {...attributes}
          {...listeners}
          className="cursor-grab text-muted-foreground p-2 -ml-2 touch-none"
          aria-label="Drag to reorder"
        >
          <GripVertical />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <GitMerge className="h-4 w-4 text-violet-400 shrink-0" />
            <p className={`font-medium break-words min-w-0 ${catalog.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>{catalog.name}</p>
            <button
              onClick={() => setShowEditDialog(true)}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <Pencil size={14} />
            </button>
            <Badge variant="outline" className="text-xs capitalize">
              {catalog.displayType || catalog.type}
            </Badge>
            <Badge variant="outline" className="font-semibold text-xs bg-violet-800/80 text-violet-200 border-violet-600/50">
              MERGED
            </Badge>
            <Badge variant="outline" className="text-xs">
              {sources.length} sources · {catalog.metadata?.mergeMode || 'interleaved'}
            </Badge>
          </div>
          <button
            onClick={() => setExpanded(v => !v)}
            className="mt-1 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
          >
            {expanded ? 'Hide sources' : 'Show sources'}
          </button>
          <div className="mt-1.5">
            <CatalogTagRow catalog={catalog} />
          </div>
        </div>

        {/* Desktop actions */}
        <div className="hidden md:flex items-center gap-1">
          <TooltipProvider delayDuration={300}>
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
              <TooltipContent>{catalog.enabled ? 'Disable' : 'Enable'}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleToggleShowInHome} disabled={!catalog.enabled}>
                  <Home className={`h-5 w-5 ${catalog.showInHome && catalog.enabled ? 'text-blue-400' : 'text-muted-foreground'}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{catalog.showInHome ? 'Remove from Home' : 'Show on Home'}</TooltipContent>
            </Tooltip>
            {hasRatingPosters && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={handleToggleRatingPosters} disabled={!catalog.enabled}>
                    <Star className={`h-5 w-5 ${catalog.enableRatingPosters !== false && catalog.enabled ? 'text-yellow-400' : 'text-muted-foreground'}`} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{catalog.enableRatingPosters !== false ? 'Disable Rating Posters' : 'Enable Rating Posters'}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleToggleRandomize} disabled={!catalog.enabled}>
                  <Shuffle className={`h-5 w-5 ${catalog.randomizePerPage && catalog.enabled ? 'text-purple-400' : 'text-muted-foreground'}`} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{catalog.randomizePerPage ? 'Original Order' : 'Randomize Order'}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleMoveToTop} aria-label="Move to Top" className="h-8 w-8 active:scale-90 transition-transform">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256" className="text-muted-foreground hover:text-foreground" fill="currentColor">
                    <path d="M213.66,194.34a8,8,0,0,1-11.32,11.32L128,131.31,53.66,205.66a8,8,0,0,1-11.32-11.32l80-80a8,8,0,0,1,11.32,0Zm-160-68.68L128,51.31l74.34,74.35a8,8,0,0,0,11.32-11.32l-80-80a8,8,0,0,0-11.32,0l-80,80a8,8,0,0,0,11.32,11.32Z" />
                  </svg>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Move to top of list</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={handleMoveToBottom} aria-label="Move to Bottom" className="h-8 w-8 active:scale-90 transition-transform">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256" className="text-muted-foreground hover:text-foreground" fill="currentColor">
                    <path d="M213.66,130.34a8,8,0,0,1,0,11.32l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,204.69l74.34-74.35A8,8,0,0,1,213.66,130.34Zm-91.32,11.32a8,8,0,0,0,11.32,0l80-80a8,8,0,0,0-11.32-11.32L128,124.69,53.66,50.34A8,8,0,0,0,42.34,61.66Z" />
                  </svg>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Move to bottom of list</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => { setSettingsMergeMode(catalog.metadata?.mergeMode || 'interleaved'); setShowSettings(true); }} className="h-8 w-8 active:scale-90 transition-transform">
                  <Settings className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Merge settings</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={onDisband} className="h-8 w-8 active:scale-90 transition-transform">
                  <Unlink className="h-5 w-5 text-red-400 hover:text-red-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Disband merged catalog</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Mobile actions */}
        <div className="flex md:hidden items-center gap-1">
          <Button variant="ghost" size="icon" onClick={handleToggleEnabled} className="h-9 w-9">
            {catalog.enabled ? (
              <Eye className="h-5 w-5 text-green-500 dark:text-green-400" />
            ) : (
              <EyeOff className="h-5 w-5 text-muted-foreground" />
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={handleToggleShowInHome} disabled={!catalog.enabled}>
                <Home className={`h-4 w-4 mr-2 ${catalog.showInHome && catalog.enabled ? 'text-blue-400' : 'text-muted-foreground'}`} />
                {catalog.showInHome && catalog.enabled ? 'Remove from Home' : 'Show on Home'}
              </DropdownMenuItem>
              {hasRatingPosters && (
                <DropdownMenuItem onClick={handleToggleRatingPosters} disabled={!catalog.enabled}>
                  <Star className={`h-4 w-4 mr-2 ${catalog.enableRatingPosters !== false && catalog.enabled ? 'text-yellow-400' : 'text-muted-foreground'}`} />
                  {catalog.enableRatingPosters !== false ? 'Disable Rating Posters' : 'Enable Rating Posters'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleToggleRandomize} disabled={!catalog.enabled}>
                <Shuffle className={`h-4 w-4 mr-2 ${catalog.randomizePerPage && catalog.enabled ? 'text-purple-400' : 'text-muted-foreground'}`} />
                {catalog.randomizePerPage ? 'Original Order' : 'Randomize Order'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setSettingsMergeMode(catalog.metadata?.mergeMode || 'interleaved'); setShowSettings(true); }}>
                <Settings className="h-4 w-4 mr-2 text-muted-foreground" />
                Merge Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleMoveToTop}>Move to Top</DropdownMenuItem>
              <DropdownMenuItem onClick={handleMoveToBottom}>Move to Bottom</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDisband} className="text-red-500">
                <Trash2 className="h-4 w-4 mr-2" />Disband
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded && sourceCatalogs.length > 0 && (
        <div className="mt-3 pl-12 space-y-1">
          {sourceCatalogs.map(sc => {
            const styleClass = sourceBadgeStyles[sc.source as keyof typeof sourceBadgeStyles] || "bg-gray-700";
            return (
              <div key={`${sc.id}-${sc.type}`} className="flex items-center gap-2 text-sm flex-wrap">
                <Badge variant="outline" className={`text-[10px] ${styleClass}`}>
                  {sourceBadgeLabels[sc.source] || sc.source.toUpperCase()}
                </Badge>
                <span className="text-muted-foreground break-words min-w-0">{sc.name}</span>
                <Badge variant="outline" className="text-[10px] capitalize">
                  {sc.displayType || sc.type}
                </Badge>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Merged Catalog</DialogTitle>
            <DialogDescription>Change the name or display type.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <Label>Name</Label>
              <Input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleEditSave()} />
            </div>
            <div>
              <Label>Display Type</Label>
              <Input value={newType} onChange={e => setNewType(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleEditSave()} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={handleEditCancel}>Cancel</Button>
              <Button onClick={handleEditSave}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge Settings</DialogTitle>
            <DialogDescription>Configure how source catalogs are combined.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <Label>Merge Mode</Label>
              <Select value={settingsMergeMode} onValueChange={(v: 'interleaved' | 'sequential' | 'alternating') => setSettingsMergeMode(v)}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="interleaved">Interleaved (A1 B1 A2 B2)</SelectItem>
                  <SelectItem value="sequential">Sequential (all A, then all B)</SelectItem>
                  <SelectItem value="alternating">Alternating (page 1 = A, page 2 = B)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowSettings(false)}>Cancel</Button>
              <Button onClick={() => {
                updateCatalog(c => ({ ...c, metadata: { ...c.metadata, mergeMode: settingsMergeMode } }));
                setShowSettings(false);
              }}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </Card>
  );
};

const SortableCatalogItem = ({ catalog, onEditDiscover, onCustomize, onDuplicateDiscover }: {
  catalog: CatalogConfig & { source?: string };
  onEditDiscover?: (catalog: CatalogConfig) => void;
  onCustomize?: (catalog: CatalogConfig) => void;
  onDuplicateDiscover?: (catalog: CatalogConfig) => void;
}) => {
  const { setConfig, config } = useConfig();
  const { toggleSelection, isSelected, selectionCount } = useSelection();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `${catalog.id}-${catalog.type}`
  });
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [newName, setNewName] = useState(catalog.name);
  const [newType, setNewType] = useState(catalog.displayType || catalog.type);
  const [showSettings, setShowSettings] = useState(false);
  const [showDisbandWarning, setShowDisbandWarning] = useState(false);
  const [disbandTargetName, setDisbandTargetName] = useState('');

  const catalogKey = `${catalog.id}-${catalog.type}`;
  const selected = isSelected(catalogKey);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 'auto',
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
        (c.id === catalog.id && c.type === catalog.type) 
          ? { ...c, enableRatingPosters: c.enableRatingPosters === false ? true : false } 
          : c
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
          ? {
              ...c,
              name: trimmedName,
              displayType: trimmedType,
              ...(c.metadata?.discover?.formState && {
                metadata: {
                  ...c.metadata,
                  discover: {
                    ...c.metadata.discover,
                    formState: {
                      ...c.metadata.discover.formState,
                      catalogName: trimmedName,
                    },
                  },
                },
              }),
            }
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

  const wouldDisbandMerge = (): string | null => {
    const targetKey = `${catalog.id}-${catalog.type}`;
    for (const c of config.catalogs) {
      if (c.source !== 'merged') continue;
      const sources = c.metadata?.mergedSources || [];
      const remaining = sources.filter(s => `${s.catalogId}-${s.catalogType}` !== targetKey);
      if (remaining.length < sources.length && remaining.length < 2) return c.name || c.id;
    }
    return null;
  };

  const executeDelete = () => {
    setConfig(prev => {
      const targetKey = `${catalog.id}-${catalog.type}`;
      let next = prev.catalogs;

      next = next.map(c => {
        if (c.source !== 'merged') return c;
        const sources = c.metadata?.mergedSources || [];
        const filtered = sources.filter(s => `${s.catalogId}-${s.catalogType}` !== targetKey);
        if (filtered.length === sources.length) return c;
        return { ...c, metadata: { ...c.metadata, mergedSources: filtered } };
      });

      const orphans = next.filter(c =>
        c.source === 'merged' && (c.metadata?.mergedSources?.length || 0) < 2
      );
      for (const merged of orphans) {
        const sources = merged.metadata?.mergedSources || [];
        next = next
          .filter(c => !(c.id === merged.id && c.type === merged.type))
          .map(c => {
            const src = sources.find(s => s.catalogId === c.id && s.catalogType === c.type);
            if (!src) return c;
            const { mergedInto, ...rest } = c;
            return {
              ...rest,
              enabled: src.originalEnabled,
              showInHome: src.originalShowInHome,
            };
          });
      }

      const liveMergedIds = new Set(
        next.filter(c => c.source === 'merged').map(c => c.id)
      );
      next = next.map(c => {
        if (!c.mergedInto) return c;
        if (liveMergedIds.has(c.mergedInto)) return c;
        const { mergedInto, ...rest } = c;
        return rest;
      });

      next = next.filter(c => !(c.id === catalog.id && c.type === catalog.type));

      return { ...prev, catalogs: reconcileMergedReferences(next) };
    });
  };

  const handleDelete = () => {
    const mergeName = wouldDisbandMerge();
    if (mergeName) {
      setDisbandTargetName(mergeName);
      setShowDisbandWarning(true);
    } else {
      executeDelete();
    }
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

  const hasRatingPosters = !!(config.apiKeys?.rpdb || config.apiKeys?.topPoster || config.customPosterUrlPattern);
  const hasSettings = catalog.source === 'mdblist' || catalog.source === 'trakt' || (catalog.source === 'simkl' && !catalog.id.startsWith('simkl.watchlist.')) || catalog.source === 'letterboxd' || catalog.source === 'streaming' ||
    (catalog.source === 'tmdb' && (catalog.id === 'tmdb.year' || catalog.id === 'tmdb.language')) ||
    !!(config.apiKeys?.traktTokenId || config.apiKeys?.anilistTokenId || config.apiKeys?.mdblist);
  const isDiscover = catalog.id.includes('.discover.') && !!catalog.metadata?.discover?.formState;
  const canDelete = true;

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative flex flex-col md:flex-row md:items-center md:justify-between p-4",
        // Smooth transitions for all properties
        "transition-all duration-200 ease-out",
        // Dragging state
        isDragging && "opacity-80 scale-[1.02] shadow-2xl ring-2 ring-primary/50",
        // Hover lift
        !isDragging && "hover:-translate-y-[1px] hover:shadow-md",
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
      {/* --- Group Dragging Badge --- */}
      {isDragging && selected && selectionCount > 1 && (
        <div className="absolute -top-3 -right-3 z-[60] animate-in zoom-in duration-200">
          <Badge className="bg-blue-600 text-white shadow-xl px-3 py-1 flex items-center gap-1.5 border-2 border-background">
            <Layers className="h-3.5 w-3.5" />
            <span className="font-bold">Moving {selectionCount} items</span>
          </Badge>
        </div>
      )}

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
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={`font-medium transition-colors break-words min-w-0 ${catalog.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>{catalog.name}</p>
            <button
              onClick={() => setShowEditDialog(true)}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <Pencil size={14} />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {/* Show itemCount and author only on screens >= sm for trakt and mdblist */}
            <div className="hidden sm:inline-flex gap-2 flex-wrap">
              {(catalog.source === 'trakt' || catalog.source === 'mdblist') && (catalog as any).metadata?.itemCount !== undefined && (
                <Badge variant="outline" className="text-xs">
                  {(catalog as any).metadata.itemCount} items
                </Badge>
              )}
              {(catalog.source === 'trakt' || catalog.source === 'mdblist') && (catalog as any).metadata?.author && (
                <Badge variant="outline" className="text-xs">
                  @{(catalog as any).metadata.author}
                </Badge>
              )}
            </div>
            {/* Show only type badge on mobile */}
            <Badge
              variant="outline"
              className={`text-xs capitalize ${catalog.enabled ? '' : 'opacity-50'} flex sm:hidden`}
            >
              {catalog.displayType || catalog.type}
            </Badge>
            {/* Show type badge on desktop as well */}
            <Badge
              variant="outline"
              className={`text-xs capitalize ${catalog.enabled ? '' : 'opacity-50'} hidden sm:flex`}
            >
              {catalog.displayType || catalog.type}
            </Badge>
            {catalog.mergedInto && (() => {
              const parent = config.catalogs.find(c => c.id === catalog.mergedInto);
              return (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <GitMerge className="h-3.5 w-3.5 text-purple-400 shrink-0 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <p className="text-xs">Part of <span className="font-medium">{parent?.name || 'a merged catalog'}</span></p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })()}
          </div>
          <div className="mt-1.5">
            <CatalogTagRow catalog={catalog} />
          </div>
        </div>
      </div>

      {/* Row 2 (Mobile): Compact actions with overflow menu */}
      <div className="flex md:hidden items-center gap-2 mt-3 justify-between">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={handleToggleEnabled} className="h-9 w-9 active:scale-90 transition-transform">
            {catalog.enabled ? (
              <Eye className="h-5 w-5 text-green-500 dark:text-green-400" />
            ) : (
              <EyeOff className="h-5 w-5 text-muted-foreground" />
            )}
          </Button>
          <Badge variant="outline" className={`font-semibold text-xs ${badgeStyle}`}>
            {sourceBadgeLabels[badgeSource] || badgeSource.toUpperCase()}
          </Badge>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={handleToggleShowInHome} disabled={!catalog.enabled}>
              <Home className={`h-4 w-4 mr-2 ${catalog.showInHome && catalog.enabled ? 'text-blue-400' : 'text-muted-foreground'}`} />
              {catalog.showInHome && catalog.enabled ? 'Remove from Home' : 'Show on Home'}
            </DropdownMenuItem>
            {hasRatingPosters && (
              <DropdownMenuItem onClick={handleToggleRatingPosters} disabled={!catalog.enabled}>
                <Star className={`h-4 w-4 mr-2 ${catalog.enableRatingPosters !== false && catalog.enabled ? 'text-yellow-400' : 'text-muted-foreground'}`} />
                {catalog.enableRatingPosters !== false ? 'Disable Rating Posters' : 'Enable Rating Posters'}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={handleToggleRandomize} disabled={!catalog.enabled}>
              <Shuffle className={`h-4 w-4 mr-2 ${catalog.randomizePerPage && catalog.enabled ? 'text-purple-400' : 'text-muted-foreground'}`} />
              {catalog.randomizePerPage ? 'Original Order' : 'Randomize Order'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleMoveToTop}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256" className="h-4 w-4 mr-2 text-muted-foreground" fill="currentColor">
                <path d="M213.66,194.34a8,8,0,0,1-11.32,11.32L128,131.31,53.66,205.66a8,8,0,0,1-11.32-11.32l80-80a8,8,0,0,1,11.32,0Zm-160-68.68L128,51.31l74.34,74.35a8,8,0,0,0,11.32-11.32l-80-80a8,8,0,0,0-11.32,0l-80,80a8,8,0,0,0,11.32,11.32Z" />
              </svg>
              Move to Top
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleMoveToBottom}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256" className="h-4 w-4 mr-2 text-muted-foreground" fill="currentColor">
                <path d="M213.66,130.34a8,8,0,0,1,0,11.32l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,204.69l74.34-74.35A8,8,0,0,1,213.66,130.34Zm-91.32,11.32a8,8,0,0,0,11.32,0l80-80a8,8,0,0,0-11.32-11.32L128,124.69,53.66,50.34A8,8,0,0,0,42.34,61.66Z" />
              </svg>
              Move to Bottom
            </DropdownMenuItem>
            {hasSettings && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setShowSettings(true)}>
                  <Settings className="h-4 w-4 mr-2 text-muted-foreground" />
                  Settings
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onClick={() => setShowEditDialog(true)}>
              <Pencil className="h-4 w-4 mr-2 text-muted-foreground" />
              Rename
            </DropdownMenuItem>
            {isDiscover && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onEditDiscover?.(catalog)}>
                  <Wand2 className="h-4 w-4 mr-2 text-muted-foreground" />
                  Edit Filters
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDuplicateDiscover?.(catalog)}>
                  <Copy className="h-4 w-4 mr-2 text-muted-foreground" />
                  Duplicate
                </DropdownMenuItem>
              </>
            )}
            {onCustomize && (
              <DropdownMenuItem onClick={() => onCustomize(catalog)}>
                <Wand2 className="h-4 w-4 mr-2 text-blue-400" />
                Clone as Built Catalog
              </DropdownMenuItem>
            )}
            {canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleDelete} className="text-red-400 focus:text-red-400">
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Row 2 (Desktop): Full action buttons + Source badge */}
      <div className="hidden md:flex items-center flex-wrap gap-2 md:ml-auto justify-end">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleToggleEnabled} className="active:scale-90 transition-transform">
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
                className="disabled:opacity-20 disabled:cursor-not-allowed active:scale-90 transition-transform"
              >
                <Home className={`h-5 w-5 transition-colors ${catalog.showInHome && catalog.enabled ? 'text-blue-500 dark:text-blue-400' : 'text-muted-foreground'}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>{catalog.showInHome && catalog.enabled ? 'Featured on Home Board' : 'Not on Home Board'}</p></TooltipContent>
          </Tooltip>

          {(config.apiKeys?.rpdb || config.apiKeys?.topPoster || config.customPosterUrlPattern) && (
            <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleToggleRatingPosters}
                disabled={!catalog.enabled}
                className="disabled:opacity-20 disabled:cursor-not-allowed active:scale-90 transition-transform"
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
                className="disabled:opacity-20 disabled:cursor-not-allowed active:scale-90 transition-transform"
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
              <Button variant="ghost" size="icon" onClick={handleMoveToTop} aria-label="Move to Top" className="h-8 w-8 active:scale-90 transition-transform">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256" className="text-muted-foreground hover:text-foreground" fill="currentColor">
                  <path d="M213.66,194.34a8,8,0,0,1-11.32,11.32L128,131.31,53.66,205.66a8,8,0,0,1-11.32-11.32l80-80a8,8,0,0,1,11.32,0Zm-160-68.68L128,51.31l74.34,74.35a8,8,0,0,0,11.32-11.32l-80-80a8,8,0,0,0-11.32,0l-80,80a8,8,0,0,0,11.32,11.32Z" />
                </svg>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Move to top of list</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleMoveToBottom} aria-label="Move to Bottom" className="h-8 w-8 active:scale-90 transition-transform">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 256 256" className="text-muted-foreground hover:text-foreground" fill="currentColor">
                  <path d="M213.66,130.34a8,8,0,0,1,0,11.32l-80,80a8,8,0,0,1-11.32,0l-80-80a8,8,0,0,1,11.32-11.32L128,204.69l74.34-74.35A8,8,0,0,1,213.66,130.34Zm-91.32,11.32a8,8,0,0,0,11.32,0l80-80a8,8,0,0,0-11.32-11.32L128,124.69,53.66,50.34A8,8,0,0,0,42.34,61.66Z" />
                </svg>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Move to bottom of list</TooltipContent>
          </Tooltip>


          {/* Settings Gear - Now show for all catalogs if any tracking is connected */}
          {(catalog.source === 'mdblist' || catalog.source === 'trakt' || (catalog.source === 'simkl' && !catalog.id.startsWith('simkl.watchlist.')) || catalog.source === 'letterboxd' || catalog.source === 'streaming' || catalog.source === 'publicmetadb' ||
            (catalog.source === 'tmdb' && (catalog.id === 'tmdb.year' || catalog.id === 'tmdb.language')) ||
            (config.apiKeys?.traktTokenId || config.apiKeys?.anilistTokenId || config.apiKeys?.mdblist)) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setShowSettings(true)} aria-label={`${catalog.source} Settings`} className="active:scale-90 transition-transform">
                  <Settings className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{`${catalog.source} Settings`}</TooltipContent>
            </Tooltip>
          )}

          {/* Remove redundant individual source checks since we combined them above */}
          {false && catalog.source === 'custom' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setShowSettings(true)} aria-label="Cache Settings">
                  <Settings className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Cache Settings</TooltipContent>
            </Tooltip>
          )}

          {/* Redundant check removed */}
          {false && catalog.source === 'anilist' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => setShowSettings(true)} aria-label="AniList Settings">
                  <Settings className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>AniList Settings</TooltipContent>
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

          {!catalog.id.includes('.discover.') &&
           ((catalog.source === 'mdblist' && ((catalog as any).metadata?.url || ((catalog as any).metadata?.author && catalog.name))) ||
            (catalog.source === 'letterboxd' && (catalog as any).metadata?.url) ||
            (catalog.source === 'trakt' && ((catalog as any).metadata?.url || catalog.id.startsWith('trakt.list.') || (catalog.id.startsWith('trakt.') && (catalog as any).metadata?.author))) ||
            (catalog.source === 'tmdb' && catalog.id.startsWith('tmdb.list.') && ((catalog as any).metadata?.url || (catalog as any).metadata?.listId)) ||
            (catalog.source === 'anilist' && catalog.id.startsWith('anilist.') && ((catalog as any).metadata?.url || ((catalog as any).metadata?.username && (catalog as any).metadata?.listName)))) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    let listUrl: string | null = null;
                    
                    if (catalog.source === 'letterboxd') {
                      listUrl = (catalog as any).metadata?.url || null;
                    } else if (catalog.source === 'mdblist') {
                      listUrl = (catalog as any).metadata?.url || null;
                      
                      if (!listUrl && (catalog as any).metadata?.author && catalog.name) {
                        // Construct URL from username and list name
                        const username = (catalog as any).metadata.author.toLowerCase().replace(/\s+/g, '');
                        const listSlug = catalog.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                        listUrl = `https://mdblist.com/lists/${username}/${listSlug}`;
                      }
                    } else if (catalog.source === 'trakt') {
                      listUrl = (catalog as any).metadata?.url || null;
                      
                      if (!listUrl) {
                        const catalogId = catalog.id;
                        
                        if (catalogId.startsWith('trakt.list.')) {
                          // Numeric ID format: https://trakt.tv/lists/{id}
                          const numericId = catalogId.replace('trakt.list.', '');
                          listUrl = `https://trakt.tv/lists/${numericId}`;
                        } else if (catalogId.startsWith('trakt.') && (catalog as any).metadata?.author) {
                          // Username.slug format: https://trakt.tv/users/{username}/lists/{slug}
                          const parts = catalogId.split('.');
                          const username = (catalog as any).metadata.author;
                          const listSlug = parts.length >= 3 ? parts.slice(2).join('.') : catalog.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                          listUrl = `https://trakt.tv/users/${username}/lists/${listSlug}`;
                        }
                      }
                    } else if (catalog.source === 'tmdb' && catalog.id.startsWith('tmdb.list.')) {
                      listUrl = (catalog as any).metadata?.url || null;
                      
                      if (!listUrl && (catalog as any).metadata?.listId) {
                        const listId = (catalog as any).metadata.listId;
                        listUrl = `https://www.themoviedb.org/list/${listId}`;
                      } else if (!listUrl) {
                        const catalogId = catalog.id;
                        const match = catalogId.match(/^tmdb\.list\.([^.]+)/);
                        if (match) {
                          const listId = match[1];
                          listUrl = `https://www.themoviedb.org/list/${listId}`;
                        }
                      }
                    } else if (catalog.source === 'anilist' && catalog.id.startsWith('anilist.')) {
                      listUrl = (catalog as any).metadata?.url || null;
                      
                      if (!listUrl && (catalog as any).metadata?.username && (catalog as any).metadata?.listName) {
                        const username = (catalog as any).metadata.username;
                        const listName = (catalog as any).metadata.listName;
                        listUrl = `https://anilist.co/user/${username}/animelist/${encodeURIComponent(listName)}`;
                      } else if (!listUrl) {
                        const catalogId = catalog.id;
                        const parts = catalogId.split('.');
                        if (parts.length === 2) {
                          if ((catalog as any).metadata?.username) {
                            const username = (catalog as any).metadata.username;
                            const listName = parts[1];
                            listUrl = `https://anilist.co/user/${username}/animelist/${encodeURIComponent(listName)}`;
                          }
                        } else if (parts.length >= 3) {
                          // anilist.{username}.{listName}
                          const username = parts[1];
                          const listName = parts.slice(2).join('.');
                          listUrl = `https://anilist.co/user/${username}/animelist/${encodeURIComponent(listName)}`;
                        }
                      }
                    }
                    
                    if (listUrl) {
                      window.open(listUrl, '_blank', 'noopener,noreferrer');
                    }
                  }}
                  aria-label={`View on ${catalog.source === 'mdblist' ? 'MDBList' : catalog.source === 'letterboxd' ? 'Letterboxd' : catalog.source === 'trakt' ? 'Trakt' : catalog.source === 'tmdb' ? 'TMDB' : 'AniList'}`}
                >
                  <ExternalLink className="h-5 w-5 text-blue-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>View on {catalog.source === 'mdblist' ? 'MDBList' : catalog.source === 'letterboxd' ? 'Letterboxd' : catalog.source === 'trakt' ? 'Trakt' : catalog.source === 'tmdb' ? 'TMDB' : 'AniList'}</TooltipContent>
            </Tooltip>
          )}

          {/* Edit button for discover catalogs with formState */}
          {catalog.id.includes('.discover.') &&
            catalog.metadata?.discover?.formState && (
            <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onEditDiscover?.(catalog)}
                  aria-label="Edit Catalog"
                  className="active:scale-90 transition-transform"
                >
                  <Wand2 className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit catalog filters</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDuplicateDiscover?.(catalog)}
                  aria-label="Duplicate Catalog"
                  className="active:scale-90 transition-transform"
                >
                  <Copy className="h-5 w-5 text-muted-foreground hover:text-foreground" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Duplicate catalog</TooltipContent>
            </Tooltip>
            </>
          )}

          <Tooltip>
                <TooltipTrigger asChild>
                  {onCustomize && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onCustomize(catalog)}
                      aria-label="Customize as Discover Catalog"
                      className="active:scale-90 transition-transform"
                    >
                      <Wand2 className="h-5 w-5 text-blue-500 hover:text-blue-600" />
                    </Button>
                  )}
                </TooltipTrigger>
                <TooltipContent>Clone and Edit as Built Catalog</TooltipContent>
              </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={handleDelete} aria-label="Delete Catalog" className="active:scale-90 transition-transform">
                <Trash2 className="h-5 w-5 text-red-500" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove from your catalog list</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className="shrink-0">
          <Badge variant="outline" className={`font-semibold ${badgeStyle}`}>
            {sourceBadgeLabels[badgeSource] || badgeSource.toUpperCase()}
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

      <SimklSettingsDialog
        catalog={catalog}
        isOpen={showSettings && catalog.source === 'simkl'}
        onClose={() => setShowSettings(false)}
      />

      <LetterboxdSettingsDialog
        catalog={catalog}
        isOpen={showSettings && catalog.source === 'letterboxd'}
        onClose={() => setShowSettings(false)}
      />

      <StreamingSettingsDialog
        catalog={catalog}
        isOpen={showSettings && catalog.source === 'streaming'}
        onClose={() => setShowSettings(false)}
      />

      <TMDBSettingsDialog
        catalog={catalog}
        isOpen={showSettings && catalog.source === 'tmdb' && (catalog.id === 'tmdb.year' || catalog.id === 'tmdb.language')}
        onClose={() => setShowSettings(false)}
      />

      <CustomManifestSettingsDialog
        catalog={catalog}
        isOpen={showSettings && catalog.source === 'custom'}
        onClose={() => setShowSettings(false)}
      />


      <AniListSettingsDialog
        catalog={catalog}
        isOpen={showSettings && catalog.source === 'anilist'}
        onClose={() => setShowSettings(false)}
      />

      <PMDBSettingsDialog
        catalog={catalog}
        isOpen={showSettings && catalog.source === 'publicmetadb'}
        onClose={() => setShowSettings(false)}
      />

      <GenericSettingsDialog
        catalog={catalog}
        isOpen={showSettings &&
          catalog.source !== 'mdblist' &&
          catalog.source !== 'trakt' &&
          catalog.source !== 'simkl' &&
          catalog.source !== 'letterboxd' &&
          catalog.source !== 'streaming' &&
          catalog.source !== 'custom' &&
          catalog.source !== 'anilist' &&
          catalog.source !== 'publicmetadb' &&
          !(catalog.source === 'tmdb' && (catalog.id === 'tmdb.year' || catalog.id === 'tmdb.language'))
        }
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
      <ConfirmDialog
        isOpen={showDisbandWarning}
        onClose={() => setShowDisbandWarning(false)}
        onConfirm={() => { setShowDisbandWarning(false); executeDelete(); }}
        title="This will disband a merged catalog"
        description={`Deleting "${catalog.name}" will leave "${disbandTargetName}" with fewer than 2 sources, so it will be automatically disbanded.`}
        confirmText="Delete anyway"
        variant="destructive"
      />
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
  setHideDisabledCatalogs,
  tagFilters,
  setTagFilters
}: {
  hideDisabledCatalogs: boolean;
  setHideDisabledCatalogs: (value: boolean) => void;
  tagFilters: string[];
  setTagFilters: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const { config, setConfig, hasBuiltInTvdb } = useConfig();
  const {
    selectAll,
    deselectAll,
    selectBySource,
    deselectBySource,
    selectByType,
    deselectByType,
    selectByTag,
    deselectByTag,
    invertSelection,
    selectionCount,
    selectedIds
  } = useSelection();
  const [isMdbListOpen, setIsMdbListOpen] = useState(false);
  const [isTraktOpen, setIsTraktOpen] = useState(false);
  const [isSimklOpen, setIsSimklOpen] = useState(false);
  const [isPublicMetaDBOpen, setIsPublicMetaDBOpen] = useState(false);
  const [isTmdbListOpen, setIsTmdbListOpen] = useState(false);
  const [isTmdbDiscoverBuilderOpen, setIsTmdbDiscoverBuilderOpen] = useState(false);
  const [editingDiscoverCatalog, setEditingDiscoverCatalog] = useState<CatalogConfig | null>(null);
  const [customizeTemplate, setCustomizeTemplate] = useState<CustomizeTemplate | null>(null);
  const [isLetterboxdOpen, setIsLetterboxdOpen] = useState(false);
  const [isAniListOpen, setIsAniListOpen] = useState(false);
  const [isCustomManifestOpen, setIsCustomManifestOpen] = useState(false);
  const [isStreamingTop10Open, setIsStreamingTop10Open] = useState(false);
  const [isAIOMetadataOpen, setIsAIOMetadataOpen] = useState(false);
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);
  const [isAICatalogOpen, setIsAICatalogOpen] = useState(false);
  const [streamingDialogOpen, setStreamingDialogOpen] = useState(false);
  const [tempSelectedProviders, setTempSelectedProviders] = useState<string[]>([]);
  const [showDeleteConfirmDialog, setShowDeleteConfirmDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [exportJson, setExportJson] = useState('');
  const [exportStats, setExportStats] = useState<{ exported: number; skipped: number; skippedReasons: string[] } | null>(null);
  const [includeUserSpecific, setIncludeUserSpecific] = useState(false);
  const [importTab, setImportTab] = useState<'paste' | 'url' | 'file'>('paste');
  const [importText, setImportText] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [isImportLoading, setIsImportLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [excludeDisabled, setExcludeDisabled] = useState(false);
  const [builtOnly, setBuiltOnly] = useState(false);
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
    | 'moveToTop'     
    | 'moveToBottom' 
    | null
  >(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );


  const isInitialMount = useRef(true);
  useEffect(() => { isInitialMount.current = false; }, []);

  const [hasChosenCatalogSetup, setHasChosenCatalogSetup] = useState(
    () => config.catalogSetupComplete === true
  );

  useEffect(() => {
    if (config.catalogSetupComplete) {
      setHasChosenCatalogSetup(true);
    }
  }, [config.catalogSetupComplete]);

  const handleCustomize = (catalog: CatalogConfig) => {
    const getTemplate = DEFAULT_CATALOG_TEMPLATES[catalog.id];
    if (getTemplate) {
      setCustomizeTemplate(getTemplate(catalog));
      setIsTmdbDiscoverBuilderOpen(true);
    }
  };

  const handleDuplicateDiscover = (catalog: CatalogConfig) => {
    const sanitizedName = (catalog.name + ' (Copy)')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'catalog';
    const uniqueSuffix = Date.now().toString(36);
    const source = catalog.metadata?.discover?.source || catalog.source || 'tmdb';
    const SOURCE_PREFIXES: Record<string, string> = {
      tmdb: 'tmdb.discover', tvdb: 'tvdb.discover', simkl: 'simkl.discover',
      mal: 'mal.discover', anilist: 'anilist.discover', mdblist: 'mdblist.discover',
    };
    const sourcePrefix = SOURCE_PREFIXES[source] ?? 'tmdb.discover';
    const catalogType = catalog.type || 'movie';
    const newId = `${sourcePrefix}.${catalogType}.${sanitizedName}.${uniqueSuffix}`;

    const newCatalog: CatalogConfig = {
      ...catalog,
      id: newId,
      name: catalog.name + ' (Copy)',
      metadata: catalog.metadata ? {
        ...catalog.metadata,
        discover: catalog.metadata.discover ? {
          ...catalog.metadata.discover,
          formState: catalog.metadata.discover.formState ? {
            ...catalog.metadata.discover.formState,
            catalogName: catalog.name + ' (Copy)',
          } : undefined,
        } : undefined,
      } : undefined,
    };

    setConfig(prev => ({
      ...prev,
      catalogs: [...prev.catalogs, newCatalog],
    }));
    toast.success('Catalog duplicated', {
      description: `${newCatalog.name} added to your catalog list`
    });
  };
  
  const handleLoadDefaults = () => {
    setConfig(prev => ({
      ...prev,
      catalogSetupComplete: true,
      catalogs: allCatalogDefinitions.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        source: c.source,
        enabled: c.isEnabledByDefault || false,
        showInHome: c.showOnHomeByDefault || false,
        enableRatingPosters: true,
        randomizePerPage: false,
      })),
    }));
    setHasChosenCatalogSetup(true);
  };
  
  const handleStartBlank = () => {
    setConfig(prev => ({
      ...prev,
      catalogSetupComplete: true,
      catalogs: [],
    }));
    setHasChosenCatalogSetup(true);
    setIsTmdbDiscoverBuilderOpen(true);
  };


  // Check if TVDB key is available
  const hasTvdbKey = !!config.apiKeys?.tvdb?.trim() || hasBuiltInTvdb;

  const handleBulkMoveToTop = () => {
    setLoadingAction('moveToTop');
    setIsLoading(true);
    try {
      setConfig(prev => {
        const selected = prev.catalogs.filter(c => selectedIds.has(`${c.id}-${c.type}`));
        const remaining = prev.catalogs.filter(c => !selectedIds.has(`${c.id}-${c.type}`));
        return { ...prev, catalogs: [...selected, ...remaining] };
      });
      toast.success(`Moved ${selectedIds.size} catalogs to top of the list`);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

  const handleBulkMoveToBottom = () => {
    setLoadingAction('moveToBottom');
    setIsLoading(true);
    try {
      setConfig(prev => {
        const selected = prev.catalogs.filter(c => selectedIds.has(`${c.id}-${c.type}`));
        const remaining = prev.catalogs.filter(c => !selectedIds.has(`${c.id}-${c.type}`));
        return { ...prev, catalogs: [...remaining, ...selected] };
      });
      toast.success(`Moved ${selectedIds.size} catalogs to bottom of the list`);
    } finally {
      setIsLoading(false);
      setLoadingAction(null);
    }
  };

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
      // Absorbed catalogs remain visible (with a badge) so they can be merged elsewhere

      // Filter out disabled catalogs if hideDisabledCatalogs is true
      if (hideDisabledCatalogs && !cat.enabled) return false;

      // Filter out TVDB catalogs if no TVDB key is available
      if (cat.source === 'tvdb' && !hasTvdbKey) return false;

      // Filter by selected tags (match any)
      if (tagFilters.length > 0 && !tagFilters.some(t => cat.tags?.includes(t))) return false;

      if (cat.source !== "streaming") return true;
      const serviceId = cat.id.replace("streaming.", "").replace(/ .*/, "");
      return Array.isArray(config.streaming) && config.streaming.includes(serviceId);
    }),
    [config.catalogs, config.streaming, hideDisabledCatalogs, hasTvdbKey, tagFilters]
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
  
    const activeKey = active.id as string;
    const overKey = over.id as string;
  
    setConfig(prev => {
      const currentCatalogs = [...prev.catalogs];
      const getCatalogKey = (catalog: CatalogConfig) => `${catalog.id}-${catalog.type}`;
      
      const movingKeys = selectedIds.has(activeKey)
        ? currentCatalogs
            .map(getCatalogKey)
            .filter(key => selectedIds.has(key))
        : [activeKey];

      const movingKeySet = new Set(movingKeys);
      const movingItems = currentCatalogs.filter(c => movingKeySet.has(getCatalogKey(c)));
      const remainingItems = currentCatalogs.filter(c => !movingKeySet.has(getCatalogKey(c)));
  
      const activeIndexTotal = currentCatalogs.findIndex(c => getCatalogKey(c) === activeKey);
      const overIndexTotal = currentCatalogs.findIndex(c => getCatalogKey(c) === overKey);
      if (activeIndexTotal === -1 || overIndexTotal === -1) return prev;

      const isMovingDown = activeIndexTotal < overIndexTotal;
      const remainingBeforeOver = currentCatalogs
        .slice(0, overIndexTotal)
        .filter(c => !movingKeySet.has(getCatalogKey(c))).length;

      const insertIndex = isMovingDown
        ? remainingBeforeOver + (movingKeySet.has(overKey) ? 0 : 1)
        : remainingBeforeOver;
  
      const newCatalogs = [...remainingItems];
      newCatalogs.splice(insertIndex, 0, ...movingItems);
  
      return { ...prev, catalogs: newCatalogs };
    });
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
                sort: 'popularity',
                sortDirection: 'desc',
              });
            }
          });
        } else {
          // Enable existing catalogs
          ['movie', 'series'].forEach(type => {
            const catalogId = `streaming.${serviceId}`;
            const existingCatalogIndex = newCatalogs.findIndex(c => c.id === catalogId && c.type === type);
            if (existingCatalogIndex !== -1) {
              console.log('ðŸ”— [Streaming] Enabling existing catalog:', catalogId);
              const [catalog] = newCatalogs.splice(existingCatalogIndex, 1);
              newCatalogs.push({
                ...catalog,
                enabled: true,
                showInHome: true,
                sort: catalog.sort || 'popularity',
                sortDirection: catalog.sortDirection || 'desc',
              });
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
  const handleBulkSetDisplayType = (displayType: string) => {
    setIsLoading(true);
    try {
      setConfig(prev => ({
        ...prev,
        catalogs: prev.catalogs.map(c => {
          const catalogKey = `${c.id}-${c.type}`;
          if (selectedCatalogs.some(cat => `${cat.id}-${cat.type}` === catalogKey)) {
            return { ...c, displayType };
          }
          return c;
        })
      }));
      toast.success(`Display type set to "${displayType}" for ${selectedCatalogs.length} catalog${selectedCatalogs.length === 1 ? '' : 's'}`);
    } catch (error) {
      showBulkActionError('set display type', error as Error);
    } finally {
      setIsLoading(false);
    }
  };
  const handleBulkResetDisplayType = () => {
    setIsLoading(true);
    try {
      const count = selectedCatalogs.filter(c => c.displayType).length;
      setConfig(prev => ({
        ...prev,
        catalogs: prev.catalogs.map(c => {
          const catalogKey = `${c.id}-${c.type}`;
          if (selectedCatalogs.some(cat => `${cat.id}-${cat.type}` === catalogKey)) {
            const { displayType, ...rest } = c as any;
            return rest;
          }
          return c;
        })
      }));
      toast.success(`Display type reset for ${count} catalog${count === 1 ? '' : 's'}`);
    } catch (error) {
      showBulkActionError('reset display type', error as Error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBulkFindReplaceType = (find: string, replace: string) => {
    setIsLoading(true);
    try {
      let count = 0;
      setConfig(prev => ({
        ...prev,
        catalogs: prev.catalogs.map(c => {
          const catalogKey = `${c.id}-${c.type}`;
          if (!selectedCatalogs.some(cat => `${cat.id}-${cat.type}` === catalogKey)) return c;
          const currentType = c.displayType || c.type;
          if (currentType === find) {
            count++;
            return { ...c, displayType: replace };
          }
          return c;
        })
      }));
      toast.success(`Replaced "${find}" â†’ "${replace}" for ${count} catalog${count === 1 ? '' : 's'}`);
    } catch (error) {
      showBulkActionError('find and replace type', error as Error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExport = () => {
    try {
      const { payload, exportedCount, skippedCount, skippedReasons } = buildExportPayload(
        config.catalogs,
        includeUserSpecific,
        excludeDisabled,
        builtOnly
      );
      setExportJson(exportToJson(payload));
      setExportStats({ exported: exportedCount, skipped: skippedCount, skippedReasons });
      setShowExportDialog(true);
    } catch (error) {
      toast.error('Failed to export', { description: (error as Error).message });
    }
  };

  const handleReExport = (includeUser?: boolean, excludeDisabledOverride?: boolean, builtOnlyOverride?: boolean) => {
    try {
      const { payload, exportedCount, skippedCount, skippedReasons } = buildExportPayload(
        config.catalogs,
        includeUser ?? includeUserSpecific,
        excludeDisabledOverride ?? excludeDisabled,
        builtOnlyOverride ?? builtOnly
      );
      setExportJson(exportToJson(payload));
      setExportStats({ exported: exportedCount, skipped: skippedCount, skippedReasons });
    } catch (error) {
      toast.error('Failed to export', { description: (error as Error).message });
    }
  };

  const handleImportFromText = (value: string) => {
    setImportText(value);
    setImportError('');
    setImportPreview(null);
    if (!value.trim()) return;
    try {
      const result = parseImportJson(value);
      setImportPreview(result);
    } catch (error) {
      setImportError((error as Error).message);
    }
  };

  const handleImportFromUrl = async () => {
    if (!importUrl.trim()) return;
    setIsImportLoading(true);
    setImportError('');
    setImportPreview(null);
    try {
      const result = await fetchAndParseUrl(importUrl.trim());
      setImportPreview(result);
    } catch (error) {
      setImportError((error as Error).message);
    } finally {
      setIsImportLoading(false);
    }
  };

  const handleImportConfirm = () => {
    if (!importPreview) return;
    try {
      const newCatalogs = mergeCatalogs(config.catalogs, importPreview.payload.catalogs, importMode);
      setConfig(prev => ({ ...prev, catalogs: reconcileMergedReferences(newCatalogs) }));
      toast.success(`Imported ${importPreview.catalogCount} catalogs`, {
        description: importMode === 'replace'
          ? 'Matching catalogs replaced, new catalogs added'
          : 'Existing catalogs updated, new catalogs added',
      });
      setShowImportDialog(false);
    } catch (error) {
      toast.error('Import failed', { description: (error as Error).message });
    }
  };

  const resetImportDialog = () => {
    setImportText('');
    setImportUrl('');
    setImportPreview(null);
    setImportError('');
    setImportTab('paste');
    setImportMode('merge');
    setIsImportLoading(false);
  };

  // Merge dialog state
  const [showMergeDialog, setShowMergeDialog] = useState(false);
  const [mergeName, setMergeName] = useState('');
  const [mergeShowInHome, setMergeShowInHome] = useState(true);
  const [mergeDisplayType, setMergeDisplayType] = useState('');
  const [mergeMode, setMergeMode] = useState<'interleaved' | 'sequential' | 'alternating'>('interleaved');

  const openMergeDialog = () => {
    if (selectedCatalogs.some(c => c.source === 'merged')) {
      toast.error('Cannot include an existing merged catalog in a new merge.');
      return;
    }
    if (selectedCatalogs.length < 2) {
      toast.error('Select at least 2 catalogs to merge.');
      return;
    }
    const baseName = selectedCatalogs.slice(0, 3).map(c => c.name).join(' + ')
      + (selectedCatalogs.length > 3 ? ` +${selectedCatalogs.length - 3}` : '');
    setMergeName(baseName);
    setMergeShowInHome(true);
    setMergeDisplayType('');
    setMergeMode('interleaved');
    setShowMergeDialog(true);
  };

  const handleConfirmMerge = () => {
    const types = new Set(selectedCatalogs.map(c => c.type));
    const mergedType: CatalogConfig['type'] = types.size === 1
      ? ([...types][0] as CatalogConfig['type'])
      : 'all';

    const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const mergeId = `merged.${uuid.replace(/-/g, '').slice(0, 12)}`;

    const mergedSources = selectedCatalogs.map(c => ({
      catalogId: c.id,
      catalogType: c.type,
      originalEnabled: !!c.enabled,
      originalShowInHome: !!c.showInHome,
    }));

    const newCatalog: CatalogConfig = {
      id: mergeId,
      name: mergeName.trim() || 'Merged Catalog',
      type: mergedType,
      enabled: true,
      source: 'merged',
      showInHome: mergeShowInHome,
      displayType: mergeDisplayType.trim() || undefined,
      metadata: { mergedSources, mergeMode },
    };

    setConfig(prev => {
      const selectedKeys = new Set(selectedCatalogs.map(s => `${s.id}-${s.type}`));
      const updated = prev.catalogs.map(c =>
        selectedKeys.has(`${c.id}-${c.type}`) ? { ...c, mergedInto: mergeId } : c
      );
      const firstAbsorbedIdx = updated.findIndex(c => selectedKeys.has(`${c.id}-${c.type}`));
      const insertAt = firstAbsorbedIdx >= 0 ? firstAbsorbedIdx : updated.length;
      const withMerged = [...updated.slice(0, insertAt), newCatalog, ...updated.slice(insertAt)];
      return { ...prev, catalogs: reconcileMergedReferences(withMerged) };
    });
    deselectAll();
    setShowMergeDialog(false);
    toast.success(`Merged ${mergedSources.length} catalogs into "${newCatalog.name}"`);
  };

  const handleDisbandMerge = (mergedCatalog: CatalogConfig) => {
    const sources = mergedCatalog.metadata?.mergedSources || [];

    setConfig(prev => {
      const idx = prev.catalogs.findIndex(c =>
        c.id === mergedCatalog.id && c.type === mergedCatalog.type
      );
      if (idx === -1) return prev;

      const restored = prev.catalogs
        .filter((_, i) => i !== idx)
        .map(c => {
          const src = sources.find(s => s.catalogId === c.id && s.catalogType === c.type);
          if (!src) return c;
          const { mergedInto, ...rest } = c;
          return {
            ...rest,
            enabled: src.originalEnabled,
            showInHome: src.originalShowInHome,
          };
        });
      return { ...prev, catalogs: reconcileMergedReferences(restored) };
    });

    toast.success(`Disbanded "${mergedCatalog.name}"`);
  };

  const handleBulkDelete = () => {
    // Show confirmation dialog
    setShowDeleteConfirmDialog(true);
  };

  const isRemovableCatalog = (_catalog: CatalogConfig) => true;

  const handleConfirmBulkDelete = async () => {
    setShowDeleteConfirmDialog(false);
    setIsLoading(true);
    setLoadingAction('delete');

    try {
      // Split selection: merged catalogs get disbanded, non-merged get deleted.
      const toDisband = selectedCatalogs.filter(c => c.source === 'merged');
      const toDelete = selectedCatalogs.filter(c => c.source !== 'merged' && isRemovableCatalog(c));
      const skippedCount = selectedCatalogs.length - toDisband.length - toDelete.length;

      if (toDisband.length > 0 || toDelete.length > 0) {
        setConfig(prev => {
          let next = prev.catalogs;

          // 1) Disband each selected merged catalog: restore sources & remove merged entry.
          for (const merged of toDisband) {
            const sources = merged.metadata?.mergedSources || [];
            const idx = next.findIndex(c => c.id === merged.id && c.type === merged.type);
            if (idx === -1) continue;
            next = next
              .filter((_, i) => i !== idx)
              .map(c => {
                const src = sources.find(s => s.catalogId === c.id && s.catalogType === c.type);
                if (!src) return c;
                const { mergedInto, ...rest } = c;
                return {
                  ...rest,
                  enabled: src.originalEnabled,
                  showInHome: src.originalShowInHome,
                };
              });
          }

          // 2) Defensive scrub: for every still-living merged catalog, drop any
          //    mergedSources that point at catalogs we're about to delete.
          const toDeleteKeys = new Set(toDelete.map(c => `${c.id}-${c.type}`));
          next = next.map(c => {
            if (c.source !== 'merged') return c;
            const sources = c.metadata?.mergedSources || [];
            const filtered = sources.filter(s => !toDeleteKeys.has(`${s.catalogId}-${s.catalogType}`));
            if (filtered.length === sources.length) return c;
            return { ...c, metadata: { ...c.metadata, mergedSources: filtered } };
          });

          // 3) Auto-disband merged catalogs that fell below 2 sources after the
          //    scrub (orphans). Restore any remaining sources first.
          const orphanMerged: typeof next = next.filter(c =>
            c.source === 'merged' && (c.metadata?.mergedSources?.length || 0) < 2
          );
          for (const merged of orphanMerged) {
            const sources = merged.metadata?.mergedSources || [];
            next = next
              .filter(c => !(c.id === merged.id && c.type === merged.type))
              .map(c => {
                const src = sources.find(s => s.catalogId === c.id && s.catalogType === c.type);
                if (!src) return c;
                const { mergedInto, ...rest } = c;
                return {
                  ...rest,
                  enabled: src.originalEnabled,
                  showInHome: src.originalShowInHome,
                };
              });
          }

          // 4) Apply the regular delete now that no merged catalog references them.
          next = next.filter(c => !toDeleteKeys.has(`${c.id}-${c.type}`));

          return { ...prev, catalogs: reconcileMergedReferences(next) };
        });
      }

      // Show toast notifications using helper
      showBulkDeleteSuccess({
        affectedCount: toDelete.length + toDisband.length,
        skippedCount,
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

  if (!hasChosenCatalogSetup) {
    return (
      <CatalogStarterChoice
        onChooseDefaults={handleLoadDefaults}
        onChooseBlank={handleStartBlank}
      />
    );
  }

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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <Eye className="h-4 w-4 text-green-500 dark:text-green-400" /> Enabled
            </div>
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <Home className="h-4 w-4 text-blue-500 dark:text-blue-400" /> Home
            </div>
            <button
              onClick={() => setHideDisabledCatalogs(!hideDisabledCatalogs)}
              className="flex items-center gap-1.5 whitespace-nowrap px-2 py-1 rounded-md border border-border hover:bg-accent transition-colors text-xs sm:text-sm"
            >
              {hideDisabledCatalogs ? (
                <>
                  <Eye className="h-4 w-4 shrink-0" />
                  <span>Show All</span>
                </>
              ) : (
                <>
                  <EyeOff className="h-4 w-4 shrink-0" />
                  <span className="hidden sm:inline">Hide Disabled</span>
                  <span className="sm:hidden">Hide Disabled</span>
                </>
              )}
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Button onClick={() => setIsQuickAddOpen(true)} size="sm" variant="default">
              <Link className="h-4 w-4 mr-2" />
              Quick Add
            </Button>
            <Button onClick={() => setIsTmdbDiscoverBuilderOpen(true)} size="sm" variant="outline">
              <Wand2 className="h-4 w-4 mr-2" />
              Build Your Catalog
            </Button>
            {(config.apiKeys?.openrouter || config.apiKeys?.gemini) && (
              <Button onClick={() => setIsAICatalogOpen(true)} size="sm" variant="outline">
                <Sparkles className="h-4 w-4 mr-2" />
                AI Catalog
              </Button>
            )}
            <Button onClick={handleExport} size="sm" variant="outline">
              <Upload className="h-4 w-4 mr-2" />
              Share Setup
            </Button>
            <Button onClick={() => { resetImportDialog(); setShowImportDialog(true); }} size="sm" variant="outline">
              <Download className="h-4 w-4 mr-2" />
              Import Setup
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <TooltipProvider delayDuration={200}>
              <div className="flex items-center flex-wrap gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsAIOMetadataOpen(true)}
                      aria-label="AIOMetadata Catalogs"
                      className="h-9 w-9"
                    >
                      <img src="/logo.png" alt="AIOMetadata" className="h-5 w-5 object-contain" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>AIOMetadata Built-in Catalogs</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsMdbListOpen(true)}
                      aria-label="MDBList Integration"
                      className="h-9 w-9"
                    >
                      <img src="/mdblist_icon.png" alt="MDBList" className="h-5 w-5 object-contain" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>MDBList Integration</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={() => setIsTraktOpen(true)} 
                      aria-label="Trakt Integration"
                      className="h-9 w-9"
                    >
                      <img src="/trakt_icon.png" alt="Trakt" className="h-5 w-5 object-contain" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Trakt Integration</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={() => setIsSimklOpen(true)} 
                      aria-label="Simkl Integration"
                      className="h-9 w-9"
                    >
                      <img 
                        src="https://us.simkl.in/img_favicon/v2/favicon-192x192.png" 
                        alt="Simkl" 
                        className="h-5 w-5 rounded object-contain" 
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Simkl Integration</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsPublicMetaDBOpen(true)}
                      aria-label="PublicMetaDB Integration"
                      className="h-9 w-9"
                    >
                      <Database className="w-5 h-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>PublicMetaDB Integration</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsTmdbListOpen(true)}
                      aria-label="TMDB Lists"
                      className="h-9 w-9"
                    >
                      <img src="/tmdb_icon.png" alt="TMDB" className="h-5 w-5 object-contain" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>TMDB Lists</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={() => setIsLetterboxdOpen(true)} 
                      aria-label="Letterboxd Integration"
                      className="h-9 w-9"
                    >
                      <img src="/letterboxd_icon.png" alt="Letterboxd" className="h-5 w-5 object-contain" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Letterboxd Integration</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={() => setIsAniListOpen(true)} 
                      aria-label="AniList Integration"
                      className="h-9 w-9"
                    >
                      <img src="/anilist_icon.png" alt="AniList" className="h-5 w-5 object-contain" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>AniList Integration</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={handleOpenStreamingDialog} 
                      aria-label="Streaming Providers"
                      className="h-9 w-9"
                    >
                      <img src="/streamingservices_icon.png" alt="Streaming" className="h-5 w-5 object-contain" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Streaming Providers</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsStreamingTop10Open(true)}
                      aria-label="Streaming Top 10"
                      className="h-9 w-9"
                    >
                      <Trophy className="w-5 h-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Streaming Top 10</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsCustomManifestOpen(true)}
                      aria-label="Import Custom Manifest"
                      className="h-9 w-9"
                    >
                      <img src="/manifest_icon.png" alt="Manifest" className="h-5 w-5 object-contain" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Import Custom Manifest</TooltipContent>
                </Tooltip>

                <div className="h-6 w-px bg-border mx-1" /> {/* Divider */}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" onClick={handleReloadCatalogs} aria-label="Reload Catalogs" className="h-9 w-9">
                      <RefreshCw className="w-5 h-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refresh catalogs to look for updates</TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
          </div>
          
          {/* Hint for users */}
          <p className="text-xs text-muted-foreground">
            Tap service icons above for advanced integration settings
          </p>
          
          {/* Dialog components */}
          <MDBListIntegration
            isOpen={isMdbListOpen}
            onClose={() => setIsMdbListOpen(false)}
          />
          <TraktIntegration
            isOpen={isTraktOpen}
            onClose={() => setIsTraktOpen(false)}
          />
          <SimklIntegration
            isOpen={isSimklOpen}
            onClose={() => setIsSimklOpen(false)}
          />
          <PublicMetaDBIntegration
            isOpen={isPublicMetaDBOpen}
            onClose={() => setIsPublicMetaDBOpen(false)}
          />
          <LetterboxdIntegration
            isOpen={isLetterboxdOpen}
            onClose={() => setIsLetterboxdOpen(false)}
          />
          <AniListIntegration
            isOpen={isAniListOpen}
            onClose={() => setIsAniListOpen(false)}
          />
          <StreamingTop10Integration
            isOpen={isStreamingTop10Open}
            onClose={() => setIsStreamingTop10Open(false)}
          />
          <AIOMetadataIntegration
            isOpen={isAIOMetadataOpen}
            onClose={() => setIsAIOMetadataOpen(false)}
          />
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
          onMoveToTop={handleBulkMoveToTop}       
          onMoveToBottom={handleBulkMoveToBottom}
          onEnableRatingPosters={handleBulkEnableRatingPosters}
          onDisableRatingPosters={handleBulkDisableRatingPosters}
          onEnableRandomize={handleBulkEnableRandomize}
          onDisableRandomize={handleBulkDisableRandomize}
          onSetDisplayType={handleBulkSetDisplayType}
          onResetDisplayType={handleBulkResetDisplayType}
          onFindReplaceType={handleBulkFindReplaceType}
          onMergeSelected={openMergeDialog}
          hasRatingPostersKey={!!config.apiKeys?.rpdb || !!config.apiKeys?.topPoster || !!config.customPosterUrlPattern}
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
        <SelectByFieldControl
          catalogs={filteredCatalogs}
          field="source"
          label="Select by Source"
          shortLabel="By Source"
          onSelect={selectBySource}
          onDeselect={deselectBySource}
        />
        <SelectByFieldControl
          catalogs={filteredCatalogs}
          field="type"
          label="Select by Type"
          shortLabel="By Type"
          onSelect={selectByType}
          onDeselect={deselectByType}
        />
        <SelectByTagControl onSelect={selectByTag} onDeselect={deselectByTag} />
      </div>

      <TagFilterBar
        tagFilters={tagFilters}
        onToggle={(name) => setTagFilters(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name])}
        onClear={() => setTagFilters([])}
      />

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
            <AnimatePresence mode="popLayout" initial={false}>
            {filteredCatalogs.map((catalog, index) => (
              <motion.div
                key={`${catalog.id}-${catalog.type}`}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
                transition={{
                  duration: 0.2,
                  delay: isInitialMount.current ? Math.min(index * 0.015, 0.5) : 0,
                }}
              >
              {catalog.source === 'merged' ? (
                <MergedCatalogCard
                  catalog={catalog}
                  allCatalogs={config.catalogs}
                  onDisband={() => handleDisbandMerge(catalog)}
                />
              ) : (
                <SortableCatalogItem
                  catalog={catalog}
                  onEditDiscover={(cat) => {
                    setEditingDiscoverCatalog(cat);
                    setIsTmdbDiscoverBuilderOpen(true);
                  }}
                  onCustomize={DEFAULT_CATALOG_TEMPLATES[catalog.id] ? handleCustomize : undefined}
                  onDuplicateDiscover={handleDuplicateDiscover}
                />
              )}
              </motion.div>
            ))}
            </AnimatePresence>
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
      <SimklIntegration
        isOpen={isSimklOpen}
        onClose={() => setIsSimklOpen(false)}
      />
      <PublicMetaDBIntegration
        isOpen={isPublicMetaDBOpen}
        onClose={() => setIsPublicMetaDBOpen(false)}
      />
      <TMDBIntegration
        isOpen={isTmdbListOpen}
        onClose={() => setIsTmdbListOpen(false)}
      />
      <LetterboxdIntegration
        isOpen={isLetterboxdOpen}
        onClose={() => setIsLetterboxdOpen(false)}
      />
      <CustomManifestIntegration
        isOpen={isCustomManifestOpen}
        onClose={() => setIsCustomManifestOpen(false)}
      />
      <StreamingTop10Integration
        isOpen={isStreamingTop10Open}
        onClose={() => setIsStreamingTop10Open(false)}
      />
      <QuickAddDialog
        isOpen={isQuickAddOpen}
        onClose={() => setIsQuickAddOpen(false)}
      />
      <AICatalogDialog
        isOpen={isAICatalogOpen}
        onClose={() => setIsAICatalogOpen(false)}
      />
      <DiscoverBuilderDialog
        isOpen={isTmdbDiscoverBuilderOpen}
        onClose={() => {
          setIsTmdbDiscoverBuilderOpen(false);
          setEditingDiscoverCatalog(null);
          setCustomizeTemplate(null);
        }}
        editingCatalog={editingDiscoverCatalog}
        customizeTemplate={customizeTemplate}
      />

      {/* Merge Dialog */}
      <Dialog open={showMergeDialog} onOpenChange={setShowMergeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge {selectedCatalogs.length} Catalogs</DialogTitle>
            <DialogDescription>
              The selected catalogs will appear as one combined catalog in Stremio.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="merge-name">Name</Label>
              <Input
                id="merge-name"
                value={mergeName}
                onChange={e => setMergeName(e.target.value)}
                placeholder="Merged Catalog"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="merge-display-type">Display Type (optional)</Label>
              <Input
                id="merge-display-type"
                value={mergeDisplayType}
                onChange={e => setMergeDisplayType(e.target.value)}
                placeholder={(() => {
                  const types = new Set(selectedCatalogs.map(c => c.type));
                  return types.size === 1 ? [...types][0] : 'all';
                })()}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="merge-home">Show in Home Board</Label>
              <Switch
                id="merge-home"
                checked={mergeShowInHome}
                onCheckedChange={setMergeShowInHome}
              />
            </div>
            <div className="space-y-2">
              <Label>Merge Mode</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMergeMode('interleaved')}
                  className={`flex-1 rounded-md border p-2.5 text-left transition-colors ${
                    mergeMode === 'interleaved'
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <p className="text-sm font-medium">Interleaved</p>
                  <p className="text-xs text-muted-foreground">Mix items from all sources (A B A B)</p>
                </button>
                <button
                  type="button"
                  onClick={() => setMergeMode('sequential')}
                  className={`flex-1 rounded-md border p-2.5 text-left transition-colors ${
                    mergeMode === 'sequential'
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <p className="text-sm font-medium">Sequential</p>
                  <p className="text-xs text-muted-foreground">Show all of source A, then B, etc.</p>
                </button>
                <button
                  type="button"
                  onClick={() => setMergeMode('alternating')}
                  className={`flex-1 rounded-md border p-2.5 text-left transition-colors ${
                    mergeMode === 'alternating'
                      ? 'border-primary bg-primary/10'
                      : 'border-border hover:border-primary/50'
                  }`}
                >
                  <p className="text-sm font-medium">Alternating</p>
                  <p className="text-xs text-muted-foreground">Page 1 = A, page 2 = B, cycle</p>
                </button>
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              Type preview: <code className="font-mono">{
                (new Set(selectedCatalogs.map(c => c.type)).size === 1)
                  ? selectedCatalogs[0]?.type
                  : 'all'
              }</code>
            </div>
            <div className="border rounded p-2 max-h-48 overflow-y-auto space-y-1">
              {selectedCatalogs.map(c => {
                const styleClass = sourceBadgeStyles[c.source as keyof typeof sourceBadgeStyles] || 'bg-gray-700';
                return (
                  <div key={`${c.id}-${c.type}`} className="flex items-center gap-2 text-sm">
                    <Badge variant="outline" className={`text-[10px] ${styleClass}`}>
                      {sourceBadgeLabels[c.source] || c.source.toUpperCase()}
                    </Badge>
                    <span className="truncate">{c.name}</span>
                    <Badge variant="outline" className="text-[10px] capitalize ml-auto">
                      {c.displayType || c.type}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowMergeDialog(false)}>Cancel</Button>
            <Button
              onClick={handleConfirmMerge}
              disabled={!mergeName.trim() || selectedCatalogs.length < 2}
            >
              <GitMerge className="h-4 w-4 mr-1" />
              Create Merged Catalog
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showDeleteConfirmDialog}
        onClose={() => setShowDeleteConfirmDialog(false)}
        onConfirm={handleConfirmBulkDelete}
        title="Delete Selected Catalogs"
        description={(() => {
          const mergedSelected = selectedCatalogs.filter(c => c.source === 'merged');
          const catalogsToDelete = selectedCatalogs.filter(c => c.source !== 'merged' && isRemovableCatalog(c));
          const skippedCount = selectedCatalogs.length - mergedSelected.length - catalogsToDelete.length;

          const parts: string[] = [];
          if (catalogsToDelete.length > 0) {
            parts.push(`delete ${catalogsToDelete.length} catalog${catalogsToDelete.length === 1 ? '' : 's'}`);
          }
          if (mergedSelected.length > 0) {
            parts.push(`disband ${mergedSelected.length} merged catalog${mergedSelected.length === 1 ? '' : 's'}`);
          }
          let message = parts.length > 0
            ? `This will ${parts.join(' and ')}.`
            : 'Nothing selected to delete.';

          if (catalogsToDelete.length > 0 && catalogsToDelete.length <= 10) {
            const catalogNames = catalogsToDelete.map(c => `• ${c.name}`).join('\n');
            message += `\n\n${catalogNames}`;
          } else if (catalogsToDelete.length > 10) {
            const firstTen = catalogsToDelete.slice(0, 10).map(c => `• ${c.name}`).join('\n');
            message += `\n\n${firstTen}\n• ...and ${catalogsToDelete.length - 10} more`;
          }

          if (mergedSelected.length > 0 && mergedSelected.length <= 5) {
            const names = mergedSelected.map(c => `• ${c.name} (merged)`).join('\n');
            message += `\n\n${names}`;
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

      {/* Export Setup Dialog */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Share Your Catalog Setup</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Copy the JSON below or download it to share on Discord.
          </p>
          {exportStats && (
            <div className="text-sm text-muted-foreground">
              <p>{exportStats.exported} catalogs exported{exportStats.skipped > 0 && `, ${exportStats.skipped} skipped`}</p>
              {exportStats.skippedReasons.length > 0 && exportStats.skippedReasons.length <= 5 && (
                <p className="text-xs mt-1 text-muted-foreground/60">
                  Skipped: {exportStats.skippedReasons.join(', ')}
                </p>
              )}
            </div>
          )}
          <textarea
            readOnly
            value={exportJson}
            className="w-full h-48 p-3 text-xs font-mono bg-muted rounded-md border resize-none focus:outline-none"
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="include-user-specific"
                checked={includeUserSpecific}
                onChange={(e) => {
                  setIncludeUserSpecific(e.target.checked);
                  handleReExport(e.target.checked, undefined, undefined);
                }}
                className="rounded"
              />
              <label htmlFor="include-user-specific" className="text-sm">
                Include user-specific catalogs (watchlists, personal lists)
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="exclude-disabled"
                checked={excludeDisabled}
                onChange={(e) => {
                  setExcludeDisabled(e.target.checked);
                  handleReExport(undefined, e.target.checked, undefined);
                }}
                className="rounded"
              />
              <label htmlFor="exclude-disabled" className="text-sm">
                Exclude disabled catalogs
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="built-only"
                checked={builtOnly}
                onChange={(e) => {
                  setBuiltOnly(e.target.checked);
                  handleReExport(undefined, undefined, e.target.checked);
                }}
                className="rounded"
              />
              <label htmlFor="built-only" className="text-sm">
                Only export built/discover catalogs
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                const blob = new Blob([exportJson], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `aiometadata-setup-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success('Downloaded!');
              }}
            >
              Download .json
            </Button>
            <Button
              onClick={() => {
                navigator.clipboard.writeText(exportJson);
                toast.success('Copied to clipboard!');
              }}
            >
              Copy to Clipboard
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Import Setup Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Import Catalog Setup</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Paste JSON or enter a URL to import someone's catalog setup.
          </p>
          {/* Tab switcher */}
          <div className="flex gap-1 p-1 bg-muted rounded-md w-fit">
            <button
              className={`px-3 py-1.5 text-sm rounded-sm transition-colors ${importTab === 'paste' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => { setImportTab('paste'); setImportError(''); setImportPreview(null); }}
            >
              Paste JSON
            </button>
            <button
              className={`px-3 py-1.5 text-sm rounded-sm transition-colors ${importTab === 'url' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => { setImportTab('url'); setImportError(''); setImportPreview(null); }}
            >
              From URL
            </button>
            <button
              className={`px-3 py-1.5 text-sm rounded-sm transition-colors ${importTab === 'file' ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => { setImportTab('file'); setImportError(''); setImportPreview(null); }}
            >
              Upload File
            </button>
          </div>

          {importTab === 'paste' && (
            <textarea
              value={importText}
              onChange={(e) => handleImportFromText(e.target.value)}
              placeholder='Paste JSON here...'
              className="w-full h-36 p-3 text-xs font-mono bg-muted rounded-md border resize-none focus:outline-none"
            />
          )}
          {importTab === 'url' && (
            <div className="flex gap-2">
              <Input
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
                placeholder="https://example.com/setup.json"
                onKeyDown={(e) => { if (e.key === 'Enter') handleImportFromUrl(); }}
                className="flex-1"
              />
              <Button
                onClick={handleImportFromUrl}
                disabled={!importUrl.trim() || isImportLoading}
                size="sm"
              >
                {isImportLoading ? 'Loading...' : 'Fetch'}
              </Button>
            </div>
          )}
          {importTab === 'file' && (
            <div
              className="flex flex-col items-center justify-center gap-2 p-6 border-2 border-dashed rounded-md cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => document.getElementById('import-file-input')?.click()}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const file = e.dataTransfer.files[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    try {
                      const text = ev.target?.result as string;
                      const result = parseImportJson(text);
                      setImportPreview(result);
                      setImportError('');
                    } catch (error) {
                      setImportError((error as Error).message);
                      setImportPreview(null);
                    }
                  };
                  reader.readAsText(file);
                }
              }}
            >
              <Download className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Click to browse or drag & drop a .json file</p>
              <input
                id="import-file-input"
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      try {
                        const text = ev.target?.result as string;
                        const result = parseImportJson(text);
                        setImportPreview(result);
                        setImportError('');
                      } catch (error) {
                        setImportError((error as Error).message);
                        setImportPreview(null);
                      }
                    };
                    reader.readAsText(file);
                  }
                  e.target.value = '';
                }}
              />
            </div>
          )}

          {importError && (
            <p className="text-sm text-red-500">{importError}</p>
          )}

          {importPreview && (
            <div className="space-y-3 p-3 bg-muted/50 rounded-md border">
              <p className="text-sm font-medium">
                {importPreview.catalogCount} catalogs found
              </p>
              <div className="text-xs text-muted-foreground space-y-0.5">
                {importPreview.defaultCount > 0 && (
                  <p>{importPreview.defaultCount} default catalogs</p>
                )}
                {importPreview.discoverCount > 0 && (
                  <p>{importPreview.discoverCount} custom/discover catalogs</p>
                )}
                {importPreview.userSpecificCount > 0 && (
                  <p className="text-yellow-600">{importPreview.userSpecificCount} user-specific catalogs (may require your own auth)</p>
                )}
                {Object.keys(importPreview.sourceBreakdown).length > 1 && (
                  <p className="mt-1">
                    Sources: {Object.entries(importPreview.sourceBreakdown)
                      .map(([source, count]) => `${source.toUpperCase()} (${count})`)
                      .join(', ')}
                  </p>
                )}
                <p className="text-muted-foreground/60 mt-1">
                  Exported {new Date(importPreview.payload.exportedAt).toLocaleDateString()}
                </p>
              </div>

              <div className="flex items-center gap-4 pt-1">
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="importMode"
                    checked={importMode === 'merge'}
                    onChange={() => setImportMode('merge')}
                  />
                  Merge
                </label>
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="importMode"
                    checked={importMode === 'replace'}
                    onChange={() => setImportMode('replace')}
                  />
                  Replace
                </label>
              </div>
              <p className="text-xs text-muted-foreground">
                {importMode === 'merge'
                  ? 'Updates settings for existing catalogs, adds new ones at the end.'
                  : 'Overwrites matching catalogs with imported settings and order.'}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowImportDialog(false)}>
              Cancel
            </Button>
            <Button
              disabled={!importPreview}
              onClick={handleImportConfirm}
            >
              Import{importPreview ? ` (${importPreview.catalogCount})` : ''}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Main export component that wraps with SelectionProvider
// ...existing code...

export function CatalogsSettings() {
  const { config, hasBuiltInTvdb, setConfig } = useConfig();
  const [hideDisabledCatalogs, setHideDisabledCatalogs] = useState(config.showDisabledCatalogs ?? false);
  const [tagFilters, setTagFilters] = useState<string[]>([]);

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
      // Absorbed catalogs remain visible so they can be merged elsewhere

      // Filter out disabled catalogs if hideDisabledCatalogs is true
      if (hideDisabledCatalogs && !cat.enabled) return false;

      // Filter out TVDB catalogs if no TVDB key is available
      if (cat.source === 'tvdb' && !hasTvdbKey) return false;

      // Filter by selected tags (match any)
      if (tagFilters.length > 0 && !tagFilters.some(t => cat.tags?.includes(t))) return false;

      if (cat.source !== "streaming") return true;
      const serviceId = cat.id.replace("streaming.", "").replace(/ .*/, "");
      return Array.isArray(config.streaming) && config.streaming.includes(serviceId);
    }),
    [config.catalogs, config.streaming, hideDisabledCatalogs, hasTvdbKey, tagFilters]
  );

  return (
    <SelectionProvider catalogs={filteredCatalogs}>
      <CatalogsSettingsContent
        hideDisabledCatalogs={hideDisabledCatalogs}
        setHideDisabledCatalogs={handleSetHideDisabled}
        tagFilters={tagFilters}
        setTagFilters={setTagFilters}
      />
    </SelectionProvider>
  );
}
