import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useConfig, CatalogConfig } from '@/contexts/ConfigContext';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertCircle, CircleHelp, Loader2, Search, Trash2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiCache } from '@/utils/apiCache';
import { X } from 'lucide-react';

interface TMDBDiscoverBuilderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  editingCatalog?: CatalogConfig | null;
  customizeTemplate?: {
    source: string;
    catalogType: 'movie' | 'series' | 'anime';
    name: string;
    formState: Record<string, any>;
  } | null;
}

type CatalogMediaType = 'movie' | 'series';
type TmdbMediaType = 'movie' | 'tv';
type DiscoverSource = 'tmdb' | 'tvdb' | 'anilist' | 'simkl' | 'mal' | 'mdblist';
type SimklDiscoverMediaType = 'movies' | 'shows' | 'anime';
type SearchEntity = 'person' | 'company' | 'keyword';
type JoinMode = 'or' | 'and';
type DatePresetKey =
  | 'last_month'
  | 'last_year'
  | 'last_5_years'
  | 'last_10_years'
  | 'era_2010s'
  | 'era_2000s'
  | 'era_1990s'
  | 'era_1980s'
  | 'clear'
  | 'custom';
type RelativeDatePresetKey = 'today' | 'last_month' | 'last_year' | 'last_5_years' | 'last_10_years';

interface TmdbGenre {
  id: number;
  name: string;
}

interface TmdbLanguage {
  iso_639_1: string;
  english_name?: string;
  name?: string;
}

interface TmdbCountry {
  iso_3166_1: string;
  english_name?: string;
  native_name?: string;
}

interface TmdbCertification {
  id?: number;
  certification: string;
  meaning?: string;
  order?: number;
}

interface TmdbWatchRegion {
  iso_3166_1: string;
  english_name?: string;
  native_name?: string;
}

interface TmdbProvider {
  provider_id: number;
  provider_name: string;
  display_priority?: number;
}

interface TmdbDiscoverReferenceResponse {
  source?: DiscoverSource;
  mediaType: TmdbMediaType;
  language: string;
  genres: TmdbGenre[];
  languages: TmdbLanguage[];
  countries: TmdbCountry[];
  watchRegions: TmdbWatchRegion[];
  certifications: Record<string, TmdbCertification[]>;
  statuses?: Array<{ id: number; name: string }>;
  defaultLanguage?: string;
  defaultCountry?: string;
}

interface TmdbEntityResult {
  id: number;
  name?: string;
  title?: string;
}

interface TmdbEntitySearchResponse {
  entity: SearchEntity;
  results: TmdbEntityResult[];
}

interface SelectionItem {
  id: number;
  label: string;
}

const MOVIE_SORT_OPTIONS = [
  { value: 'popularity.desc', label: 'Popularity (High to Low)' },
  { value: 'popularity.asc', label: 'Popularity (Low to High)' },
  { value: 'primary_release_date.desc', label: 'Release Date (Newest)' },
  { value: 'primary_release_date.asc', label: 'Release Date (Oldest)' },
  { value: 'vote_average.desc', label: 'User Score (Highest)' },
  { value: 'vote_average.asc', label: 'User Score (Lowest)' },
  { value: 'vote_count.desc', label: 'Vote Count (Highest)' },
  { value: 'revenue.desc', label: 'Revenue (Highest)' },
] as const;

const TV_SORT_OPTIONS = [
  { value: 'popularity.desc', label: 'Popularity (High to Low)' },
  { value: 'popularity.asc', label: 'Popularity (Low to High)' },
  { value: 'first_air_date.desc', label: 'First Air Date (Newest)' },
  { value: 'first_air_date.asc', label: 'First Air Date (Oldest)' },
  { value: 'vote_average.desc', label: 'User Score (Highest)' },
  { value: 'vote_average.asc', label: 'User Score (Lowest)' },
  { value: 'vote_count.desc', label: 'Vote Count (Highest)' },
] as const;

const TVDB_MOVIE_SORT_OPTIONS = [
  { value: 'score', label: 'Score' },
  { value: 'firstAired', label: 'First Aired' },
  { value: 'name', label: 'Name' },
] as const;

const TVDB_SERIES_SORT_OPTIONS = [
  { value: 'score', label: 'Score' },
  { value: 'firstAired', label: 'First Aired' },
  { value: 'lastAired', label: 'Last Aired' },
  { value: 'name', label: 'Name' },
] as const;

const TVDB_SORT_DIRECTION_OPTIONS = [
  { value: 'desc', label: 'Descending' },
  { value: 'asc', label: 'Ascending' },
] as const;

const JOIN_MODE_OPTIONS = [
  { value: 'or' as JoinMode, label: 'OR (Any Match)' },
  { value: 'and' as JoinMode, label: 'AND (All Match)' },
];

const DATE_PRESET_OPTIONS: Array<{ value: Exclude<DatePresetKey, 'custom'>; label: string }> = [
  { value: 'last_month', label: 'Last Month' },
  { value: 'last_year', label: 'Last Year' },
  { value: 'last_5_years', label: 'Last 5 Years' },
  { value: 'last_10_years', label: 'Last 10 Years' },
  { value: 'era_2010s', label: '2010s' },
  { value: 'era_2000s', label: '2000s' },
  { value: 'era_1990s', label: '1990s' },
  { value: 'era_1980s', label: '1980s' },
  { value: 'clear', label: 'Clear' },
];

const RELATIVE_DATE_PRESET_KEYS: RelativeDatePresetKey[] = [
  'today',
  'last_month',
  'last_year',
  'last_5_years',
  'last_10_years',
];
const TMDB_DYNAMIC_DATE_TOKEN_PREFIX = '__tmdb_date__';

const ANILIST_SORT_OPTIONS = [
  { value: 'TRENDING_DESC', label: 'Trending' },
  { value: 'POPULARITY_DESC', label: 'Popularity (High to Low)' },
  { value: 'POPULARITY', label: 'Popularity (Low to High)' },
  { value: 'SCORE_DESC', label: 'Score (Highest)' },
  { value: 'SCORE', label: 'Score (Lowest)' },
  { value: 'FAVOURITES_DESC', label: 'Favourites (Most)' },
  { value: 'START_DATE_DESC', label: 'Start Date (Newest)' },
  { value: 'START_DATE', label: 'Start Date (Oldest)' },
  { value: 'UPDATED_AT_DESC', label: 'Recently Updated' },
  { value: 'TITLE_ROMAJI', label: 'Title (Romaji A-Z)' },
  { value: 'TITLE_ENGLISH', label: 'Title (English A-Z)' },
] as const;

const ANILIST_FORMAT_OPTIONS = [
  { value: 'TV', label: 'TV' },
  { value: 'TV_SHORT', label: 'TV Short' },
  { value: 'MOVIE', label: 'Movie' },
  { value: 'SPECIAL', label: 'Special' },
  { value: 'OVA', label: 'OVA' },
  { value: 'ONA', label: 'ONA' },
] as const;

const ANILIST_STATUS_OPTIONS = [
  { value: 'FINISHED', label: 'Finished' },
  { value: 'RELEASING', label: 'Currently Releasing' },
  { value: 'NOT_YET_RELEASED', label: 'Not Yet Released' },
  { value: 'CANCELLED', label: 'Cancelled' },
  { value: 'HIATUS', label: 'Hiatus' },
] as const;

const ANILIST_SEASON_OPTIONS = [
  { value: 'WINTER', label: 'Winter' },
  { value: 'SPRING', label: 'Spring' },
  { value: 'SUMMER', label: 'Summer' },
  { value: 'FALL', label: 'Fall' },
] as const;

const ANILIST_COUNTRY_OPTIONS = [
  { value: 'JP', label: 'Japan' },
  { value: 'KR', label: 'South Korea' },
  { value: 'CN', label: 'China' },
  { value: 'TW', label: 'Taiwan' },
] as const;

const ANILIST_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy',
  'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological',
  'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller',
] as const;

const SIMKL_MEDIA_OPTIONS: Array<{ value: SimklDiscoverMediaType; label: string }> = [
  { value: 'movies', label: 'Movies' },
  { value: 'shows', label: 'Series' },
  { value: 'anime', label: 'Anime' },
];

const SIMKL_MOVIE_GENRE_OPTIONS = [
  'all', 'action', 'adventure', 'animation', 'comedy', 'crime', 'documentary', 'drama', 'family',
  'fantasy', 'history', 'horror', 'music', 'mystery', 'romance', 'science-fiction', 'thriller',
  'tv-movie', 'war', 'western'
] as const;

const SIMKL_TV_GENRE_OPTIONS = [
  'all', 'action', 'adventure', 'animation', 'awards-show', 'children', 'comedy', 'crime',
  'documentary', 'drama', 'family', 'fantasy', 'food', 'game-show', 'history', 'home-and-garden',
  'horror', 'indie', 'korean-drama', 'martial-arts', 'mini-series', 'musical', 'mystery', 'news',
  'podcast', 'reality', 'romance', 'science-fiction', 'soap', 'special-interest', 'sport', 'suspense',
  'talk-show', 'thriller', 'travel', 'video-game-play', 'war', 'western'
] as const;

const SIMKL_ANIME_GENRE_OPTIONS = [
  'all', 'action', 'adventure', 'comedy', 'drama', 'ecchi', 'educational', 'fantasy', 'gag-humor',
  'gore', 'harem', 'historical', 'horror', 'idol', 'isekai', 'josei', 'kids', 'magic',
  'martial-arts', 'mecha', 'military', 'music', 'mystery', 'mythology', 'parody', 'psychological',
  'racing', 'reincarnation', 'romance', 'samurai', 'school', 'sci-fi', 'seinen', 'shoujo',
  'shoujo-ai', 'shounen', 'shounen-ai', 'slice-of-life', 'space', 'sports', 'strategy-game',
  'super-power', 'supernatural', 'thriller', 'vampire', 'yaoi', 'yuri'
] as const;

const SIMKL_TV_TYPE_OPTIONS = ['all-types', 'tv-shows', 'entertainment', 'documentaries', 'animation-filter'] as const;
const SIMKL_ANIME_TYPE_OPTIONS = ['all-types', 'series', 'movies', 'ovas', 'onas'] as const;
const SIMKL_MOVIE_COUNTRY_OPTIONS = ['all', 'us', 'uk', 'ca', 'kr'] as const;
const SIMKL_TV_COUNTRY_OPTIONS = ['all', 'us', 'uk', 'ca', 'kr', 'jp'] as const;
const SIMKL_TV_NETWORK_OPTIONS = [
  'all-networks', 'netflix', 'disney', 'peacock', 'appletv', 'quibi', 'cbs', 'abc', 'fox', 'cw', 'hbo',
  'showtime', 'usa', 'syfy', 'tnt', 'fx', 'amc', 'abcfam', 'showcase', 'starz', 'mtv', 'lifetime',
  'ae', 'tvland'
] as const;
const SIMKL_ANIME_NETWORK_OPTIONS = [
  'all-networks', 'tvtokyo', 'tokyomx', 'fujitv', 'tokyobroadcastingsystem', 'tvasahi', 'wowow',
  'ntv', 'atx', 'ctc', 'nhk', 'mbs', 'animax', 'cartoonnetwork', 'abc'
] as const;
const SIMKL_MOVIE_YEAR_OPTIONS = [
  'this-week', 'this-month', 'this-year', '2019', '2018', '2017', '2016', '2015', '2014', '2013', '2012',
  '2011', '2010s', '2000s', '1990s', '1980s', '1970s', '1960s'
] as const;
const SIMKL_TV_ANIME_YEAR_OPTIONS = [
  'all-years', 'today', 'this-week', 'this-month', 'this-year', '2019', '2018', '2017', '2016',
  '2015', '2014', '2013', '2012', '2011', '2010s', '2000s', '1990s', '1980s', '1970s', '1960s'
] as const;
const SIMKL_MOVIE_SORT_OPTIONS = [
  { value: 'popular-this-week', label: 'Popular This Week' },
  { value: 'popular-this-month', label: 'Popular This Month' },
  { value: 'rank', label: 'Rank' },
  { value: 'votes', label: 'Votes' },
  { value: 'budget', label: 'Budget' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'release-date', label: 'Release Date' },
  { value: 'most-anticipated', label: 'Most Anticipated' },
  { value: 'a-z', label: 'A-Z' },
  { value: 'z-a', label: 'Z-A' },
] as const;
const SIMKL_TV_ANIME_SORT_OPTIONS = [
  { value: 'popular-today', label: 'Popular Today' },
  { value: 'popular-this-week', label: 'Popular This Week' },
  { value: 'popular-this-month', label: 'Popular This Month' },
  { value: 'rank', label: 'Rank' },
  { value: 'votes', label: 'Votes' },
  { value: 'release-date', label: 'Release Date' },
  { value: 'last-air-date', label: 'Last Air Date' },
  { value: 'a-z', label: 'A-Z' },
  { value: 'z-a', label: 'Z-A' },
] as const;


const MAL_SORT_OPTIONS = [
  { value: 'score', label: 'Score (Highest)' },
  { value: 'popularity', label: 'Popularity' },
  { value: 'rank', label: 'Rank' },
  { value: 'members', label: 'Members (Most)' },
  { value: 'favorites', label: 'Favourites (Most)' },
  { value: 'start_date', label: 'Start Date' },
  { value: 'end_date', label: 'End Date' },
  { value: 'episodes', label: 'Episode Count' },
  { value: 'title', label: 'Title (A–Z)' },
] as const;

const MDBLIST_SORT_OPTIONS = [
  { value: 'score', label: 'MDBList Score' },
  { value: 'score_average', label: 'Average Score' },
  { value: 'released', label: 'Release Date' },
  { value: 'releasedigital', label: 'Digital Release' },
  { value: 'imdbrating', label: 'IMDb Rating' },
  { value: 'imdbvotes', label: 'IMDb Votes' },
  { value: 'imdbpopular', label: 'IMDb Popularity' },
  { value: 'tmdbpopular', label: 'TMDB Popularity' },
  { value: 'metacritic', label: 'Metacritic' },
  { value: 'rtomatoes', label: 'Rotten Tomatoes' },
  { value: 'rtaudience', label: 'RT Audience' },
  { value: 'letterrating', label: 'Letterboxd Rating' },
  { value: 'title', label: 'Title' },
] as const;

const MDBLIST_SORT_DIRECTION_OPTIONS = [
  { value: 'desc', label: 'Descending' },
  { value: 'asc', label: 'Ascending' },
] as const;

const MDBLIST_STANDARD_GENRES = [
  { value: 'action', label: 'Action' },
  { value: 'adult', label: 'Adult' },
  { value: 'adventure', label: 'Adventure' },
  { value: 'animation', label: 'Animation' },
  { value: 'anime', label: 'Anime' },
  { value: 'biography', label: 'Biography' },
  { value: 'children', label: 'Children' },
  { value: 'comedy', label: 'Comedy' },
  { value: 'crime', label: 'Crime' },
  { value: 'documentary', label: 'Documentary' },
  { value: 'donghua', label: 'Donghua' },
  { value: 'drama', label: 'Drama' },
  { value: 'eastern', label: 'Eastern' },
  { value: 'family', label: 'Family' },
  { value: 'fantasy', label: 'Fantasy' },
  { value: 'film-noir', label: 'Film-Noir' },
  { value: 'game-show', label: 'Game Show' },
  { value: 'history', label: 'History' },
  { value: 'holiday', label: 'Holiday' },
  { value: 'home-and-garden', label: 'Home & Garden' },
  { value: 'horror', label: 'Horror' },
  { value: 'kids', label: 'Kids' },
  { value: 'music', label: 'Music' },
  { value: 'musical', label: 'Musical' },
  { value: 'mystery', label: 'Mystery' },
  { value: 'news', label: 'News' },
  { value: 'reality', label: 'Reality' },
  { value: 'reality-tv', label: 'Reality TV' },
  { value: 'romance', label: 'Romance' },
  { value: 'sci-fi', label: 'Sci-Fi' },
  { value: 'science-fiction', label: 'Science Fiction' },
  { value: 'short', label: 'Short' },
  { value: 'soap', label: 'Soap' },
  { value: 'special-interest', label: 'Special Interest' },
  { value: 'sport', label: 'Sport' },
  { value: 'sporting-event', label: 'Sporting Event' },
  { value: 'superhero', label: 'Superhero' },
  { value: 'suspense', label: 'Suspense' },
  { value: 'talk', label: 'Talk' },
  { value: 'talk-show', label: 'Talk Show' },
  { value: 'thriller', label: 'Thriller' },
  { value: 'tv-movie', label: 'TV Movie' },
  { value: 'war', label: 'War' },
  { value: 'western', label: 'Western' },
] as const;

const MDBLIST_ANIME_GENRES = [
  { value: 'anime-bl', label: 'BL' },
  { value: 'anime-ecchi', label: 'Ecchi' },
  { value: 'anime-historical', label: 'Historical' },
  { value: 'anime-isekai', label: 'Isekai' },
  { value: 'anime-josei', label: 'Josei' },
  { value: 'anime-martial-arts', label: 'Martial Arts' },
  { value: 'anime-mecha', label: 'Mecha' },
  { value: 'anime-military', label: 'Military' },
  { value: 'anime-music', label: 'Music (Anime)' },
  { value: 'anime-parody', label: 'Parody' },
  { value: 'anime-psychological', label: 'Psychological' },
  { value: 'anime-samurai', label: 'Samurai' },
  { value: 'anime-school', label: 'School' },
  { value: 'anime-seinen', label: 'Seinen' },
  { value: 'anime-shoujo', label: 'Shoujo' },
  { value: 'anime-shounen', label: 'Shounen' },
  { value: 'anime-slice-of-life', label: 'Slice of Life' },
  { value: 'anime-space', label: 'Space' },
  { value: 'anime-sports', label: 'Sports' },
  { value: 'anime-supernatural', label: 'Supernatural' },
  { value: 'anime-vampire', label: 'Vampire' },
  { value: 'anime-yuri', label: 'Yuri' },
] as const;

const MDBLIST_ALL_GENRES = [...MDBLIST_STANDARD_GENRES, ...MDBLIST_ANIME_GENRES];

const MAL_TYPE_OPTIONS = [
  { value: 'tv', label: 'TV' },
  { value: 'movie', label: 'Movie' },
  { value: 'ova', label: 'OVA' },
  { value: 'special', label: 'Special' },
  { value: 'ona', label: 'ONA' },
] as const;

const MAL_STATUS_OPTIONS = [
  { value: 'airing', label: 'Currently Airing' },
  { value: 'complete', label: 'Finished Airing' },
  { value: 'upcoming', label: 'Upcoming' },
] as const;

const MAL_RATING_OPTIONS = [
  { value: 'g', label: 'G - All Ages' },
  { value: 'pg', label: 'PG - Children' },
  { value: 'pg13', label: 'PG-13 - Teens 13+' },
  { value: 'r17', label: 'R - 17+' },
  { value: 'r', label: 'R+ - Mild Nudity' },
  { value: 'rx', label: 'Rx - Hentai' },
] as const;

const MAL_SORT_DIRECTION_OPTIONS = [
  { value: 'desc', label: 'Descending' },
  { value: 'asc', label: 'Ascending' },
] as const;

const NONE_VALUE = '__none__';
const MAX_VOTE_COUNT = 5000;
const MAX_RUNTIME_MINUTES = 400;

function toTmdbMediaType(type: CatalogMediaType): TmdbMediaType {
  return type === 'movie' ? 'movie' : 'tv';
}

function getDisplayTypeOverride(
  catalogType: CatalogMediaType,
  overrides?: { movie?: string; series?: string }
): string | undefined {
  if (!overrides) return undefined;
  if (catalogType === 'movie' && overrides.movie) return overrides.movie;
  if (catalogType === 'series' && overrides.series) return overrides.series;
  return undefined;
}

function joinSelectionValues(values: SelectionItem[], mode: JoinMode): string {
  const separator = mode === 'and' ? ',' : '|';
  return values.map(item => item.id).join(separator);
}

function addUniqueItem(current: SelectionItem[], item: SelectionItem): SelectionItem[] {
  if (current.some(existing => existing.id === item.id)) return current;
  return [...current, item];
}

function removeItemById(current: SelectionItem[], id: number): SelectionItem[] {
  return current.filter(item => item.id !== id);
}

function getTodayLocalDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatLocalDateForInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getDateRangeFromPreset(preset: Exclude<DatePresetKey, 'custom'>): { from: string; to: string } {
  const now = new Date();
  const to = formatLocalDateForInput(now);
  const fromDate = new Date(now);

  switch (preset) {
    case 'last_month':
      fromDate.setDate(fromDate.getDate() - 30);
      return { from: formatLocalDateForInput(fromDate), to };
    case 'last_year':
      fromDate.setFullYear(fromDate.getFullYear() - 1);
      return { from: formatLocalDateForInput(fromDate), to };
    case 'last_5_years':
      fromDate.setFullYear(fromDate.getFullYear() - 5);
      return { from: formatLocalDateForInput(fromDate), to };
    case 'last_10_years':
      fromDate.setFullYear(fromDate.getFullYear() - 10);
      return { from: formatLocalDateForInput(fromDate), to };
    case 'era_2010s':
      return { from: '2010-01-01', to: '2019-12-31' };
    case 'era_2000s':
      return { from: '2000-01-01', to: '2009-12-31' };
    case 'era_1990s':
      return { from: '1990-01-01', to: '1999-12-31' };
    case 'era_1980s':
      return { from: '1980-01-01', to: '1989-12-31' };
    case 'clear':
    default:
      return { from: '', to: '' };
  }
}

function isRelativeDatePreset(preset: DatePresetKey): preset is RelativeDatePresetKey {
  return RELATIVE_DATE_PRESET_KEYS.includes(preset as RelativeDatePresetKey);
}

function buildTmdbDateToken(preset: RelativeDatePresetKey, bound: 'from' | 'to'): string {
  return `${TMDB_DYNAMIC_DATE_TOKEN_PREFIX}:${preset}:${bound}`;
}

function applyDynamicTmdbDateTokens(
  params: Record<string, string | number | boolean>,
  catalogType: CatalogMediaType,
  movieDatePreset: DatePresetKey,
  seriesDatePreset: DatePresetKey,
  releasedOnly: boolean
): Record<string, string | number | boolean> {
  const serializedParams = { ...params };

  if (catalogType === 'movie' && releasedOnly && serializedParams['release_date.lte']) {
    serializedParams['release_date.lte'] = buildTmdbDateToken('today', 'to');
  }

  if (catalogType === 'movie' && isRelativeDatePreset(movieDatePreset)) {
    serializedParams['primary_release_date.gte'] = buildTmdbDateToken(movieDatePreset, 'from');
    serializedParams['primary_release_date.lte'] = buildTmdbDateToken(movieDatePreset, 'to');
  }

  if (catalogType === 'series' && isRelativeDatePreset(seriesDatePreset)) {
    serializedParams['first_air_date.gte'] = buildTmdbDateToken(seriesDatePreset, 'from');
    serializedParams['first_air_date.lte'] = buildTmdbDateToken(seriesDatePreset, 'to');
  }

  return serializedParams;
}

function buildTmdbDiscoverWebUrl(
  mediaType: TmdbMediaType,
  params: Record<string, string | number | boolean | null | undefined>
): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.append(key, String(value));
  });
  return `https://www.themoviedb.org/discover/${mediaType === 'movie' ? 'movie' : 'tv'}?${search.toString()}`;
}

function buildTvdbDiscoverApiUrl(
  catalogType: CatalogMediaType,
  params: Record<string, string | number | boolean | null | undefined>
): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.append(key, String(value));
  });
  const endpoint = catalogType === 'movie' ? 'movies' : 'series';
  return `https://api4.thetvdb.com/v4/${endpoint}/filter?${search.toString()}`;
}

function buildSimklDiscoverApiUrl(
  mediaType: SimklDiscoverMediaType,
  params: Record<string, string | number | boolean | null | undefined>
): string {
  const normalizedMedia = mediaType === 'movies' ? 'movies' : mediaType === 'shows' ? 'tv' : 'anime';
  const genre = String(params.genre || 'all');
  const type = String(params.type || 'all-types');
  const country = String(params.country || 'all');
  const network = String(params.network || 'all-networks');
  const year = String(params.year || (mediaType === 'movies' ? 'this-year' : 'all-years'));
  const sort = String(params.sort || 'popular-this-week');

  const pathSegments = mediaType === 'movies'
    ? [genre, type, country, year, sort]
    : mediaType === 'shows'
      ? [genre, type, country, network, year, sort]
      : [genre, type, network, year, sort];

  return `https://api.simkl.com/${normalizedMedia}/genres/${pathSegments.map(encodeURIComponent).join('/')}`;
}

function formatSimklOptionLabel(value: string): string {
  if (value === 'animation-filter') return 'Animation';
  const normalized = value.replace(/-/g, ' ');
  return normalized.replace(/\b\w/g, (c) => c.toUpperCase());
}

function getSimklDefaultType(mediaType: SimklDiscoverMediaType): string {
  return 'all-types';
}

function getSimklDefaultYear(mediaType: SimklDiscoverMediaType): string {
  return mediaType === 'movies' ? 'this-year' : 'all-years';
}

function getSimklDefaultSort(mediaType: SimklDiscoverMediaType): string {
  return mediaType === 'movies' ? 'popular-this-week' : 'popular-today';
}

function normalizeTvdbCode(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function resolveTvdbLanguageCode(languageItem: any): string {
  return normalizeTvdbCode(languageItem?.id) || normalizeTvdbCode(languageItem?.shortCode);
}

function resolveTvdbCountryCode(countryItem: any): string {
  return normalizeTvdbCode(countryItem?.id) || normalizeTvdbCode(countryItem?.shortCode);
}

function LabelWithTooltip({
  children,
  tooltip,
  htmlFor,
}: {
  children: React.ReactNode;
  tooltip: string;
  htmlFor?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{children}</Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label="Field help"
          >
            <CircleHelp className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs whitespace-normal">
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

export function TMDBDiscoverBuilderDialog({ isOpen, onClose, editingCatalog, customizeTemplate }: TMDBDiscoverBuilderDialogProps) {
  const { config, setConfig, catalogTTL, auth } = useConfig();
  const tmdbApiKey = config.apiKeys?.tmdb?.trim() || '';
  const tvdbApiKey = config.apiKeys?.tvdb?.trim() || '';
  const mdblistApiKey = config.apiKeys?.mdblist?.trim() || '';
  const hasMdblistApiKey = mdblistApiKey.length > 0;
  const [simklClientId, setSimklClientId] = useState<string>("");
  
  useEffect(() => {
    fetch("/api/config")
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data && data.simkl) setSimklClientId(data.simkl);
      });
  }, []);
  const hasSimklClientId = simklClientId.length > 0;

  const buildDiscoverRequestQuery = (source: DiscoverSource, params: Record<string, string>): string => {
    const searchParams = new URLSearchParams(params);
    const apiKey = source === 'tmdb' ? tmdbApiKey : source === 'tvdb' ? tvdbApiKey : '';
    if (apiKey) {
      searchParams.set('apikey', apiKey);
    }
    if (auth.userUUID) {
      searchParams.set('userUUID', auth.userUUID);
    }
    return searchParams.toString();
  };

  const [discoverSource, setDiscoverSource] = useState<DiscoverSource>('tmdb');
  const [catalogName, setCatalogName] = useState('');
  const [catalogType, setCatalogType] = useState<CatalogMediaType>('movie');
  const [simklMediaType, setSimklMediaType] = useState<SimklDiscoverMediaType>('movies');
  const [sortBy, setSortBy] = useState('popularity.desc');
  const [tvdbSortDirection, setTvdbSortDirection] = useState<'asc' | 'desc'>('desc');
  const [tvdbStatus, setTvdbStatus] = useState('');
  const [tvdbYear, setTvdbYear] = useState('');
  const [simklGenre, setSimklGenre] = useState('all');
  const [simklType, setSimklType] = useState(getSimklDefaultType('movies'));
  const [simklCountry, setSimklCountry] = useState('all');
  const [simklNetwork, setSimklNetwork] = useState('all-networks');
  const [simklYear, setSimklYear] = useState(getSimklDefaultYear('movies'));
  const [includeAdult, setIncludeAdult] = useState<boolean>(config.includeAdult);
  const [releasedOnly, setReleasedOnly] = useState<boolean>(false);
  const [cacheTTL, setCacheTTL] = useState<number>(Math.max(catalogTTL, 300));

  const [references, setReferences] = useState<TmdbDiscoverReferenceResponse | null>(null);
  const [isLoadingReferences, setIsLoadingReferences] = useState(false);

  const [includeGenres, setIncludeGenres] = useState<SelectionItem[]>([]);
  const [excludeGenres, setExcludeGenres] = useState<SelectionItem[]>([]);
  const [genreJoinMode, setGenreJoinMode] = useState<JoinMode>('or');
  const [pendingIncludeGenreId, setPendingIncludeGenreId] = useState<string>('');
  const [pendingExcludeGenreId, setPendingExcludeGenreId] = useState<string>('');

  const [originalLanguage, setOriginalLanguage] = useState('');
  const [originCountry, setOriginCountry] = useState('');
  const [releaseRegion, setReleaseRegion] = useState('');
  const [certificationCountry, setCertificationCountry] = useState('');
  const [certificationValue, setCertificationValue] = useState('');

  const [watchRegion, setWatchRegion] = useState('');
  const [watchProviders, setWatchProviders] = useState<SelectionItem[]>([]);
  const [providerJoinMode, setProviderJoinMode] = useState<JoinMode>('or');
  const [providerFilter, setProviderFilter] = useState('');
  const [availableProviders, setAvailableProviders] = useState<TmdbProvider[]>([]);
  const [isLoadingProviders, setIsLoadingProviders] = useState(false);

  const [peopleQuery, setPeopleQuery] = useState('');
  const [peopleResults, setPeopleResults] = useState<TmdbEntityResult[]>([]);
  const [selectedPeople, setSelectedPeople] = useState<SelectionItem[]>([]);
  const [peopleJoinMode, setPeopleJoinMode] = useState<JoinMode>('or');
  const [isSearchingPeople, setIsSearchingPeople] = useState(false);

  const [companyQuery, setCompanyQuery] = useState('');
  const [companyResults, setCompanyResults] = useState<TmdbEntityResult[]>([]);
  const [withCompanies, setWithCompanies] = useState<SelectionItem[]>([]);
  const [withoutCompanies, setWithoutCompanies] = useState<SelectionItem[]>([]);
  const [companyJoinMode, setCompanyJoinMode] = useState<JoinMode>('or');
  const [isSearchingCompanies, setIsSearchingCompanies] = useState(false);

  const [keywordQuery, setKeywordQuery] = useState('');
  const [keywordResults, setKeywordResults] = useState<TmdbEntityResult[]>([]);
  const [withKeywords, setWithKeywords] = useState<SelectionItem[]>([]);
  const [withoutKeywords, setWithoutKeywords] = useState<SelectionItem[]>([]);
  const [keywordJoinMode, setKeywordJoinMode] = useState<JoinMode>('or');
  const [isSearchingKeywords, setIsSearchingKeywords] = useState(false);
  const [selectedKeywordIds, setSelectedKeywordIds] = useState<Set<number>>(new Set());
  const [activeSearchDropdown, setActiveSearchDropdown] = useState<SearchEntity | null>(null);

  const peopleSearchRef = useRef<HTMLDivElement | null>(null);
  const companySearchRef = useRef<HTMLDivElement | null>(null);
  const keywordSearchRef = useRef<HTMLDivElement | null>(null);

  const [voteAverageRange, setVoteAverageRange] = useState<[number, number]>([0, 10]);
  const [voteCountMin, setVoteCountMin] = useState<number>(0);
  const [runtimeRange, setRuntimeRange] = useState<[number, number]>([0, MAX_RUNTIME_MINUTES]);

  const [primaryReleaseFrom, setPrimaryReleaseFrom] = useState('');
  const [primaryReleaseTo, setPrimaryReleaseTo] = useState('');
  const [movieDatePreset, setMovieDatePreset] = useState<DatePresetKey>('clear');
  const [firstAirFrom, setFirstAirFrom] = useState('');
  const [firstAirTo, setFirstAirTo] = useState('');
  const [seriesDatePreset, setSeriesDatePreset] = useState<DatePresetKey>('clear');
  const [airDateFrom, setAirDateFrom] = useState('');
  const [airDateTo, setAirDateTo] = useState('');

  // AniList-specific state
  const [anilistFormats, setAnilistFormats] = useState<string[]>([]); // multi-select
  const [anilistStatus, setAnilistStatus] = useState('');
  const [anilistSeason, setAnilistSeason] = useState('');
  const [anilistSeasonYear, setAnilistSeasonYear] = useState('');
  const [anilistCountry, setAnilistCountry] = useState('');
  const [anilistIncludeGenres, setAnilistIncludeGenres] = useState<string[]>([]);
  const [anilistExcludeGenres, setAnilistExcludeGenres] = useState<string[]>([]);
  const [anilistIncludeTags, setAnilistIncludeTags] = useState<string[]>([]);
  const [anilistExcludeTags, setAnilistExcludeTags] = useState<string[]>([]);
  const [anilistTagSearch, setAnilistTagSearch] = useState('');
  const [anilistAvailableTags, setAnilistAvailableTags] = useState<string[]>([]);
  const [anilistScoreRange, setAnilistScoreRange] = useState<[number, number]>([0, 100]);
  const [anilistPopularityMin, setAnilistPopularityMin] = useState<number>(0);
  const [anilistEpisodesRange, setAnilistEpisodesRange] = useState<[number, number]>([0, 200]);
  const [anilistDurationRange, setAnilistDurationRange] = useState<[number, number]>([0, 180]);
  const [anilistIsAdult, setAnilistIsAdult] = useState(false);
  const [anilistStartDateFrom, setAnilistStartDateFrom] = useState('');
  const [anilistStartDateTo, setAnilistStartDateTo] = useState('');
  // Studio search state
  const [anilistStudioQuery, setAnilistStudioQuery] = useState('');
  const [anilistStudioResults, setAnilistStudioResults] = useState<Array<{ id: number; name: string }>>([]);
  const [anilistSelectedStudios, setAnilistSelectedStudios] = useState<SelectionItem[]>([]);
  const [isSearchingStudios, setIsSearchingStudios] = useState(false);

  // MAL-specific state
  const [malType, setMalType] = useState(''); 
  const [malStatus, setMalStatus] = useState('');
  const [malRating, setMalRating] = useState('');
  const [malSortDirection, setMalSortDirection] = useState('desc');
  const [malIncludeGenreIds, setMalIncludeGenreIds] = useState<SelectionItem[]>([]);
  const [malExcludeGenreIds, setMalExcludeGenreIds] = useState<SelectionItem[]>([]);
  const [malAvailableGenres, setMalAvailableGenres] = useState<Array<{ id: number; name: string }>>([]);
  const [malProducers, setMalProducers] = useState<SelectionItem[]>([]);
  const [malAvailableStudios, setMalAvailableStudios] = useState<Array<{ id: number; name: string }>>([]);
  const [malStudioQuery, setMalStudioQuery] = useState('');
  const [malStudioResults, setMalStudioResults] = useState<Array<{ id: number; name: string }>>([]);
  const [isSearchingMalStudios, setIsSearchingMalStudios] = useState(false);
  const [malMinScore, setMalMinScore] = useState<number>(0);
  const [malMaxScore, setMalMaxScore] = useState<number>(10);
  const [malStartDate, setMalStartDate] = useState('');
  const [malEndDate, setMalEndDate] = useState('');
  const [malSfw, setMalSfw] = useState(true);

  // MDBList Discover state
  const [mdblistSortDirection, setMdblistSortDirection] = useState<'desc' | 'asc'>('desc');
  const [mdblistScoreMin, setMdblistScoreMin] = useState<number>(0);
  const [mdblistScoreMax, setMdblistScoreMax] = useState<number>(100);
  const [mdblistYearMin, setMdblistYearMin] = useState<string>('');
  const [mdblistYearMax, setMdblistYearMax] = useState<string>('');
  const [mdblistReleasedFrom, setMdblistReleasedFrom] = useState<string>('');
  const [mdblistReleasedTo, setMdblistReleasedTo] = useState<string>('');
  const [mdblistRuntimeMin, setMdblistRuntimeMin] = useState<string>('');
  const [mdblistRuntimeMax, setMdblistRuntimeMax] = useState<string>('');
  const [mdblistLanguage, setMdblistLanguage] = useState<string>('');
  const [mdblistCountry, setMdblistCountry] = useState<string>('');
  const [mdblistGenres, setMdblistGenres] = useState<string[]>([]);
  const [mdblistGenreMode, setMdblistGenreMode] = useState<'or' | 'and'>('or');
  const [mdblistGenreSelection, setMdblistGenreSelection] = useState<'standard' | 'anime' | 'all'>('standard');

  const [previewResults, setPreviewResults] = useState<any[]>([]);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewTotalResults, setPreviewTotalResults] = useState(0);

  const [isSaving, setIsSaving] = useState(false);
  const [showMdblistPreviewConfirm, setShowMdblistPreviewConfirm] = useState(false);
  const [mdblistPreviewRemember, setMdblistPreviewRemember] = useState(false);

  const tmdbMediaType = toTmdbMediaType(catalogType);

  const SOURCE_LABELS: Record<string, string> = {
    anilist: 'Anilist',
    tvdb: 'TVDB',
    simkl: 'Simkl',
    mal: 'MAL',
    mdblist: 'MDBList'
  };
  
  const sourceLabel = SOURCE_LABELS[discoverSource] ?? 'TMDB';

  const SOURCE_API_KEYS: Record<string, string> = {
    tmdb: tmdbApiKey,
    tvdb: tvdbApiKey,
    simkl: simklClientId,
    mal: 'public-api',
    anilist: 'public-api',
    mdblist: mdblistApiKey,
  };
  
  const activeSourceApiKey = SOURCE_API_KEYS[discoverSource] ?? 'public-api';
  
  const sortOptions = useMemo(() => {
    if (discoverSource === 'mdblist') return MDBLIST_SORT_OPTIONS;
    if (discoverSource === 'mal') return MAL_SORT_OPTIONS;
    if (discoverSource === 'anilist') return ANILIST_SORT_OPTIONS;
    if (discoverSource === 'simkl') {
      return simklMediaType === 'movies' ? SIMKL_MOVIE_SORT_OPTIONS : SIMKL_TV_ANIME_SORT_OPTIONS;
    }
    if (discoverSource === 'tvdb') {
      return catalogType === 'movie' ? TVDB_MOVIE_SORT_OPTIONS : TVDB_SERIES_SORT_OPTIONS;
    }
    return catalogType === 'movie' ? MOVIE_SORT_OPTIONS : TV_SORT_OPTIONS;
  }, [discoverSource, catalogType, simklMediaType]);

  const simklGenreOptions = useMemo(() => {
    return simklMediaType === 'movies'
      ? SIMKL_MOVIE_GENRE_OPTIONS
      : simklMediaType === 'shows'
        ? SIMKL_TV_GENRE_OPTIONS
        : SIMKL_ANIME_GENRE_OPTIONS;
  }, [simklMediaType]);

  const simklTypeOptions = useMemo(() => {
    return simklMediaType === 'anime' ? SIMKL_ANIME_TYPE_OPTIONS : SIMKL_TV_TYPE_OPTIONS;
  }, [simklMediaType]);

  const simklCountryOptions = useMemo(() => {
    return simklMediaType === 'movies' ? SIMKL_MOVIE_COUNTRY_OPTIONS : SIMKL_TV_COUNTRY_OPTIONS;
  }, [simklMediaType]);

  const simklNetworkOptions = useMemo(() => {
    return simklMediaType === 'anime' ? SIMKL_ANIME_NETWORK_OPTIONS : SIMKL_TV_NETWORK_OPTIONS;
  }, [simklMediaType]);

  const simklYearOptions = useMemo(() => {
    return simklMediaType === 'movies' ? SIMKL_MOVIE_YEAR_OPTIONS : SIMKL_TV_ANIME_YEAR_OPTIONS;
  }, [simklMediaType]);

  const sortedGenres = useMemo(
    () => (references?.genres || []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    [references]
  );

  const sortedLanguages = useMemo(
    () => (references?.languages || []).slice().sort((a, b) => (a.english_name || a.name || a.iso_639_1).localeCompare(b.english_name || b.name || b.iso_639_1)),
    [references]
  );

  const sortedCountries = useMemo(
    () => (references?.countries || []).slice().sort((a, b) => (a.english_name || a.iso_3166_1).localeCompare(b.english_name || b.iso_3166_1)),
    [references]
  );

  const sortedRegions = useMemo(
    () => (references?.watchRegions || []).slice().sort((a, b) => (a.english_name || a.iso_3166_1).localeCompare(b.english_name || b.iso_3166_1)),
    [references]
  );

  const certificationOptions = useMemo(() => {
    if (!references || !certificationCountry) return [];
    const values = references.certifications?.[certificationCountry] || [];
    const deduped = new Map<string, TmdbCertification>();
    values.forEach(value => {
      if (!value?.certification) return;
      if (!deduped.has(value.certification)) deduped.set(value.certification, value);
    });
    return Array.from(deduped.values()).sort((a, b) => {
      const orderA = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      return a.certification.localeCompare(b.certification);
    });
  }, [references, certificationCountry]);

  const tvdbStatuses = useMemo(() => {
    return (references?.statuses || [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [references]);

  const filteredProviders = useMemo(() => {
    const normalizedFilter = providerFilter.trim().toLowerCase();
    const ordered = availableProviders
      .slice()
      .sort((a, b) => {
        const priorityA = Number.isFinite(a.display_priority) ? (a.display_priority as number) : Number.MAX_SAFE_INTEGER;
        const priorityB = Number.isFinite(b.display_priority) ? (b.display_priority as number) : Number.MAX_SAFE_INTEGER;
        if (priorityA !== priorityB) return priorityA - priorityB;
        return a.provider_name.localeCompare(b.provider_name);
      });

    if (!normalizedFilter) return ordered;
    return ordered.filter(provider =>
      provider.provider_name.toLowerCase().includes(normalizedFilter)
    );
  }, [availableProviders, providerFilter]);

  const discoverParamsPreview = useMemo(() => {
    const params = buildDiscoverParams();
    return params;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    discoverSource,
    simklMediaType,
    sortBy,
    tvdbSortDirection,
    tvdbStatus,
    tvdbYear,
    simklGenre,
    simklType,
    simklCountry,
    simklNetwork,
    simklYear,
    includeAdult,
    releasedOnly,
    includeGenres,
    excludeGenres,
    genreJoinMode,
    originalLanguage,
    originCountry,
    releaseRegion,
    certificationCountry,
    certificationValue,
    selectedPeople,
    peopleJoinMode,
    withCompanies,
    withoutCompanies,
    companyJoinMode,
    withKeywords,
    withoutKeywords,
    keywordJoinMode,
    watchRegion,
    watchProviders,
    providerJoinMode,
    voteAverageRange,
    voteCountMin,
    runtimeRange,
    primaryReleaseFrom,
    primaryReleaseTo,
    firstAirFrom,
    firstAirTo,
    airDateFrom,
    airDateTo,
    catalogType,
    references,
    anilistFormats,
    anilistStatus,
    anilistSeason,
    anilistSeasonYear,
    anilistCountry,
    anilistSelectedStudios,
    anilistIncludeGenres,
    anilistExcludeGenres,
    anilistIncludeTags,
    anilistExcludeTags,
    anilistScoreRange,
    anilistPopularityMin,
    anilistEpisodesRange,
    anilistDurationRange,
    anilistIsAdult,
    anilistStartDateFrom,
    anilistStartDateTo,
    malType,
    malStatus,
    malRating,
    malSortDirection,
    malIncludeGenreIds,
    malExcludeGenreIds,
    malProducers,
    malMinScore,
    malMaxScore,
    malStartDate,
    malEndDate,
    malSfw,
    mdblistSortDirection,
    mdblistScoreMin,
    mdblistScoreMax,
    mdblistYearMin,
    mdblistYearMax,
    mdblistReleasedFrom,
    mdblistReleasedTo,
    mdblistRuntimeMin,
    mdblistRuntimeMax,
    mdblistLanguage,
    mdblistCountry,
    mdblistGenres,
    mdblistGenreMode,
  ]);

  const activeFilterCount = useMemo(() => {
    const baseKeys = discoverSource === 'tmdb'
      ? new Set(['sort_by', 'include_adult'])
      : discoverSource === 'tvdb'
           ? new Set(['sort', 'sortType', 'country', 'lang'])
           : discoverSource === 'simkl'
             ? new Set(['media', 'sort'])
           : discoverSource === 'mdblist'
             ? new Set(['sort', 'sort_order'])
           : discoverSource === 'anilist'
                  ? new Set(['sort', 'isAdult'])
                  : new Set(['order_by', 'sort', 'sfw']);
    return Object.keys(discoverParamsPreview).filter(key => !baseKeys.has(key)).length;
  }, [discoverParamsPreview, discoverSource]);

  const resetState = () => {
    setDiscoverSource('tmdb');
    setCatalogName('');
    setCatalogType('movie');
    setSimklMediaType('movies');
    setSortBy('popularity.desc');
    setTvdbSortDirection('desc');
    setTvdbStatus('');
    setTvdbYear('');
    setSimklGenre('all');
    setSimklType(getSimklDefaultType('movies'));
    setSimklCountry('all');
    setSimklNetwork('all-networks');
    setSimklYear(getSimklDefaultYear('movies'));
    setIncludeAdult(config.includeAdult);
    setReleasedOnly(false);
    setCacheTTL(Math.max(catalogTTL, 300));

    setReferences(null);
    setIncludeGenres([]);
    setExcludeGenres([]);
    setGenreJoinMode('or');
    setPendingIncludeGenreId('');
    setPendingExcludeGenreId('');

    setOriginalLanguage('');
    setOriginCountry('');
    setReleaseRegion('');
    setCertificationCountry('');
    setCertificationValue('');

    setWatchRegion('');
    setWatchProviders([]);
    setProviderJoinMode('or');
    setProviderFilter('');
    setAvailableProviders([]);

    setPeopleQuery('');
    setPeopleResults([]);
    setSelectedPeople([]);
    setPeopleJoinMode('or');

    setCompanyQuery('');
    setCompanyResults([]);
    setWithCompanies([]);
    setWithoutCompanies([]);
    setCompanyJoinMode('or');

    setKeywordQuery('');
    setKeywordResults([]);
    setSelectedKeywordIds(new Set());
    setWithKeywords([]);
    setWithoutKeywords([]);
    setKeywordJoinMode('or');
    setActiveSearchDropdown(null);

    setVoteAverageRange([0, 10]);
    setVoteCountMin(0);
    setRuntimeRange([0, MAX_RUNTIME_MINUTES]);

    setPrimaryReleaseFrom('');
    setPrimaryReleaseTo('');
    setMovieDatePreset('clear');
    setFirstAirFrom('');
    setFirstAirTo('');
    setSeriesDatePreset('clear');
    setAirDateFrom('');
    setAirDateTo('');
    setAnilistFormats([]);
    setAnilistStatus('');
    setAnilistSeason('');
    setAnilistSeasonYear('');
    setAnilistCountry('');
    setAnilistIncludeGenres([]);
    setAnilistExcludeGenres([]);
    setAnilistIncludeTags([]);
    setAnilistExcludeTags([]);
    setAnilistTagSearch('');
    setAnilistAvailableTags([]);
    setAnilistScoreRange([0, 100]);
    setAnilistPopularityMin(0);
    setAnilistEpisodesRange([0, 200]);
    setAnilistDurationRange([0, 180]);
    setAnilistIsAdult(false);
    setAnilistStartDateFrom('');
    setAnilistStartDateTo('');
    setAnilistStudioQuery('');
    setAnilistStudioResults([]);
    setAnilistSelectedStudios([]);

    setMalType('');
    setMalStatus('');
    setMalRating('');
    setMalSortDirection('desc');
    setMalIncludeGenreIds([]);
    setMalExcludeGenreIds([]);
    setMalAvailableGenres([]);
    setMalProducers([]);
    setMalAvailableStudios([]);
    setMalStudioQuery('');
    setMalStudioResults([]);
    setMalMinScore(0);
    setMalMaxScore(10);
    setMalStartDate('');
    setMalEndDate('');
    setMalSfw(true);

    setMdblistSortDirection('desc');
    setMdblistScoreMin(0);
    setMdblistScoreMax(100);
    setMdblistYearMin('');
    setMdblistYearMax('');
    setMdblistReleasedFrom('');
    setMdblistReleasedTo('');
    setMdblistRuntimeMin('');
    setMdblistRuntimeMax('');
    setMdblistLanguage('');
    setMdblistCountry('');
    setMdblistGenres([]);
    setMdblistGenreMode('or');
    setMdblistGenreSelection('standard');

    setPreviewResults([]);
    setShowPreview(false);
    setPreviewTotalResults(0);
    setIsPreviewLoading(false);

    setIsSaving(false);
  };

  useEffect(() => {
    if (!isOpen || !editingCatalog) return;

    resetState();

    const fs = editingCatalog.metadata?.discover?.formState;
    if (!fs) return;
  
    // Shared
    if (fs.catalogName) setCatalogName(fs.catalogName);
    if (fs.discoverSource) setDiscoverSource(fs.discoverSource);
    if (fs.sortBy) setSortBy(fs.sortBy);
    if (fs.cacheTTL) setCacheTTL(fs.cacheTTL);
    if (fs.catalogType) setCatalogType(fs.catalogType);
  
    // TMDB / TVDB shared
    if (fs.includeGenres) setIncludeGenres(fs.includeGenres);
    if (fs.excludeGenres) setExcludeGenres(fs.excludeGenres);
    if (fs.genreJoinMode) setGenreJoinMode(fs.genreJoinMode);
    if (fs.originalLanguage) setOriginalLanguage(fs.originalLanguage);
    if (fs.originCountry) setOriginCountry(fs.originCountry);
    if (fs.certificationCountry) setCertificationCountry(fs.certificationCountry);
    if (fs.certificationValue) setCertificationValue(fs.certificationValue);
  
    // TMDB-only
    if (typeof fs.includeAdult === 'boolean') setIncludeAdult(fs.includeAdult);
    if (typeof fs.releasedOnly === 'boolean') setReleasedOnly(fs.releasedOnly);
    if (fs.selectedPeople) setSelectedPeople(fs.selectedPeople);
    if (fs.peopleJoinMode) setPeopleJoinMode(fs.peopleJoinMode);
    if (fs.withCompanies) setWithCompanies(fs.withCompanies);
    if (fs.withoutCompanies) setWithoutCompanies(fs.withoutCompanies);
    if (fs.companyJoinMode) setCompanyJoinMode(fs.companyJoinMode);
    if (fs.withKeywords) setWithKeywords(fs.withKeywords);
    if (fs.withoutKeywords) setWithoutKeywords(fs.withoutKeywords);
    if (fs.keywordJoinMode) setKeywordJoinMode(fs.keywordJoinMode);
    if (fs.watchRegion) setWatchRegion(fs.watchRegion);
    if (fs.watchProviders) setWatchProviders(fs.watchProviders);
    if (fs.providerJoinMode) setProviderJoinMode(fs.providerJoinMode);
    if (fs.voteAverageRange) setVoteAverageRange(fs.voteAverageRange);
    if (typeof fs.voteCountMin === 'number') setVoteCountMin(fs.voteCountMin);
    if (fs.runtimeRange) setRuntimeRange(fs.runtimeRange);
    const moviePreset = fs.movieDatePreset as DatePresetKey | undefined;
    if (moviePreset) {
      setMovieDatePreset(moviePreset);
    } else if (fs.primaryReleaseFrom || fs.primaryReleaseTo) {
      setMovieDatePreset('custom');
    }
    if (moviePreset && moviePreset !== 'custom') {
      const { from, to } = getDateRangeFromPreset(moviePreset);
      setPrimaryReleaseFrom(from);
      setPrimaryReleaseTo(to);
    } else {
      if (fs.primaryReleaseFrom) setPrimaryReleaseFrom(fs.primaryReleaseFrom);
      if (fs.primaryReleaseTo) setPrimaryReleaseTo(fs.primaryReleaseTo);
    }
    const loadedSeriesPreset = fs.seriesDatePreset as DatePresetKey | undefined;
    if (loadedSeriesPreset) {
      setSeriesDatePreset(loadedSeriesPreset);
    } else if (fs.firstAirFrom || fs.firstAirTo) {
      setSeriesDatePreset('custom');
    }
    if (loadedSeriesPreset && loadedSeriesPreset !== 'custom') {
      const { from, to } = getDateRangeFromPreset(loadedSeriesPreset);
      setFirstAirFrom(from);
      setFirstAirTo(to);
    } else {
      if (fs.firstAirFrom) setFirstAirFrom(fs.firstAirFrom);
      if (fs.firstAirTo) setFirstAirTo(fs.firstAirTo);
    }
    if (fs.airDateFrom) setAirDateFrom(fs.airDateFrom);
    if (fs.airDateTo) setAirDateTo(fs.airDateTo);
    if (fs.releaseRegion) setReleaseRegion(fs.releaseRegion);
  
    // TVDB-only
    if (fs.tvdbSortDirection) setTvdbSortDirection(fs.tvdbSortDirection);
    if (fs.tvdbStatus) setTvdbStatus(fs.tvdbStatus);
    if (fs.tvdbYear) setTvdbYear(fs.tvdbYear);
  
    // Simkl
    if (fs.simklMediaType) setSimklMediaType(fs.simklMediaType);
    if (fs.simklGenre) setSimklGenre(fs.simklGenre);
    if (fs.simklType) setSimklType(fs.simklType);
    if (fs.simklCountry) setSimklCountry(fs.simklCountry);
    if (fs.simklNetwork) setSimklNetwork(fs.simklNetwork);
    if (fs.simklYear) setSimklYear(fs.simklYear);
  
    // AniList
    if (fs.anilistFormats) setAnilistFormats(fs.anilistFormats);
    if (fs.anilistStatus) setAnilistStatus(fs.anilistStatus);
    if (fs.anilistSeason) setAnilistSeason(fs.anilistSeason);
    if (fs.anilistSeasonYear) setAnilistSeasonYear(fs.anilistSeasonYear);
    if (fs.anilistCountry) setAnilistCountry(fs.anilistCountry);
    if (fs.anilistSelectedStudios) setAnilistSelectedStudios(fs.anilistSelectedStudios);
    if (fs.anilistIncludeGenres) setAnilistIncludeGenres(fs.anilistIncludeGenres);
    if (fs.anilistExcludeGenres) setAnilistExcludeGenres(fs.anilistExcludeGenres);
    if (fs.anilistIncludeTags) setAnilistIncludeTags(fs.anilistIncludeTags);
    if (fs.anilistExcludeTags) setAnilistExcludeTags(fs.anilistExcludeTags);
    if (fs.anilistScoreRange) setAnilistScoreRange(fs.anilistScoreRange);
    if (typeof fs.anilistPopularityMin === 'number') setAnilistPopularityMin(fs.anilistPopularityMin);
    if (fs.anilistEpisodesRange) setAnilistEpisodesRange(fs.anilistEpisodesRange);
    if (fs.anilistDurationRange) setAnilistDurationRange(fs.anilistDurationRange);
    if (typeof fs.anilistIsAdult === 'boolean') setAnilistIsAdult(fs.anilistIsAdult);
    if (fs.anilistStartDateFrom) setAnilistStartDateFrom(fs.anilistStartDateFrom);
    if (fs.anilistStartDateTo) setAnilistStartDateTo(fs.anilistStartDateTo);
  
    // MAL
    if (fs.malType) setMalType(fs.malType);
    if (fs.malStatus) setMalStatus(fs.malStatus);
    if (fs.malRating) setMalRating(fs.malRating);
    if (fs.malSortDirection) setMalSortDirection(fs.malSortDirection);
    if (fs.malIncludeGenreIds) setMalIncludeGenreIds(fs.malIncludeGenreIds);
    if (fs.malExcludeGenreIds) setMalExcludeGenreIds(fs.malExcludeGenreIds);
    if (fs.malProducers) setMalProducers(fs.malProducers);
    if (typeof fs.malMinScore === 'number') setMalMinScore(fs.malMinScore);
    if (typeof fs.malMaxScore === 'number') setMalMaxScore(fs.malMaxScore);
    if (fs.malStartDate) setMalStartDate(fs.malStartDate);
    if (fs.malEndDate) setMalEndDate(fs.malEndDate);
    if (typeof fs.malSfw === 'boolean') setMalSfw(fs.malSfw);

    // MDBList
    if (fs.mdblistSortDirection) setMdblistSortDirection(fs.mdblistSortDirection);
    if (typeof fs.mdblistScoreMin === 'number') setMdblistScoreMin(fs.mdblistScoreMin);
    if (typeof fs.mdblistScoreMax === 'number') setMdblistScoreMax(fs.mdblistScoreMax);
    if (fs.mdblistYearMin) setMdblistYearMin(fs.mdblistYearMin);
    if (fs.mdblistYearMax) setMdblistYearMax(fs.mdblistYearMax);
    if (fs.mdblistReleasedFrom) setMdblistReleasedFrom(fs.mdblistReleasedFrom);
    if (fs.mdblistReleasedTo) setMdblistReleasedTo(fs.mdblistReleasedTo);
    if (fs.mdblistRuntimeMin) setMdblistRuntimeMin(fs.mdblistRuntimeMin);
    if (fs.mdblistRuntimeMax) setMdblistRuntimeMax(fs.mdblistRuntimeMax);
    if (fs.mdblistLanguage) setMdblistLanguage(fs.mdblistLanguage);
    if (fs.mdblistCountry) setMdblistCountry(fs.mdblistCountry);
    if (fs.mdblistGenres) setMdblistGenres(fs.mdblistGenres);
    if (fs.mdblistGenreMode) setMdblistGenreMode(fs.mdblistGenreMode);
    if (fs.mdblistGenreSelection) setMdblistGenreSelection(fs.mdblistGenreSelection);
  }, [isOpen, editingCatalog]);

  useEffect(() => {
    if (!isOpen || !customizeTemplate || editingCatalog) return;
    const fs = customizeTemplate.formState;
    if (!fs) return;
    resetState();
    setCatalogName(customizeTemplate.name);
    setDiscoverSource(customizeTemplate.source as DiscoverSource);
    setCatalogType(customizeTemplate.catalogType as CatalogMediaType);
  
    // TMDB fields
    if (fs.sortBy) setSortBy(fs.sortBy);
    if (typeof fs.includeAdult === 'boolean') setIncludeAdult(fs.includeAdult);
    if (typeof fs.releasedOnly === 'boolean') setReleasedOnly(fs.releasedOnly);
    if (typeof fs.voteCountMin === 'number') setVoteCountMin(fs.voteCountMin);
    if (fs.voteAverageRange) setVoteAverageRange(fs.voteAverageRange);
    if (fs.runtimeRange) setRuntimeRange(fs.runtimeRange);
    if (fs.originalLanguage) setOriginalLanguage(fs.originalLanguage);
    if (fs.originCountry) setOriginCountry(fs.originCountry);
    if (fs.primaryReleaseFrom) setPrimaryReleaseFrom(fs.primaryReleaseFrom);
    if (fs.primaryReleaseTo) setPrimaryReleaseTo(fs.primaryReleaseTo);
    if (fs.firstAirFrom) setFirstAirFrom(fs.firstAirFrom);
    if (fs.firstAirTo) setFirstAirTo(fs.firstAirTo);
    if (fs.airDateFrom) setAirDateFrom(fs.airDateFrom);
    if (fs.airDateTo) setAirDateTo(fs.airDateTo);
  
    // TVDB fields
    if (fs.tvdbSortDirection) setTvdbSortDirection(fs.tvdbSortDirection);
    if (fs.tvdbStatus) setTvdbStatus(fs.tvdbStatus);
    if (fs.tvdbYear) setTvdbYear(fs.tvdbYear);
  
    // MAL fields
    if (fs.malType) setMalType(fs.malType);
    if (fs.malStatus) setMalStatus(fs.malStatus);
    if (fs.malRating) setMalRating(fs.malRating);
    if (fs.malSortDirection) setMalSortDirection(fs.malSortDirection);
    if (typeof fs.malMinScore === 'number') setMalMinScore(fs.malMinScore);
    if (typeof fs.malMaxScore === 'number') setMalMaxScore(fs.malMaxScore);
    if (fs.malStartDate) setMalStartDate(fs.malStartDate);
    if (fs.malEndDate) setMalEndDate(fs.malEndDate);
    if (typeof fs.malSfw === 'boolean') setMalSfw(fs.malSfw);
  
    // AniList fields
    if (fs.anilistFormats) setAnilistFormats(fs.anilistFormats);
    if (fs.anilistStatus) setAnilistStatus(fs.anilistStatus);
    if (fs.anilistSeason) setAnilistSeason(fs.anilistSeason);
    if (fs.anilistSeasonYear) setAnilistSeasonYear(fs.anilistSeasonYear);
    if (fs.anilistCountry) setAnilistCountry(fs.anilistCountry);
  
    // Simkl fields
    if (fs.simklMediaType) setSimklMediaType(fs.simklMediaType);
    if (fs.simklGenre) setSimklGenre(fs.simklGenre);
    if (fs.simklType) setSimklType(fs.simklType);
    if (fs.simklCountry) setSimklCountry(fs.simklCountry);
    if (fs.simklNetwork) setSimklNetwork(fs.simklNetwork);
    if (fs.simklYear) setSimklYear(fs.simklYear);

    // MDBList fields
    if (fs.mdblistSortDirection) setMdblistSortDirection(fs.mdblistSortDirection);
    if (typeof fs.mdblistScoreMin === 'number') setMdblistScoreMin(fs.mdblistScoreMin);
    if (typeof fs.mdblistScoreMax === 'number') setMdblistScoreMax(fs.mdblistScoreMax);
    if (fs.mdblistYearMin) setMdblistYearMin(fs.mdblistYearMin);
    if (fs.mdblistYearMax) setMdblistYearMax(fs.mdblistYearMax);
    if (fs.mdblistReleasedFrom) setMdblistReleasedFrom(fs.mdblistReleasedFrom);
    if (fs.mdblistReleasedTo) setMdblistReleasedTo(fs.mdblistReleasedTo);
    if (fs.mdblistRuntimeMin) setMdblistRuntimeMin(fs.mdblistRuntimeMin);
    if (fs.mdblistRuntimeMax) setMdblistRuntimeMax(fs.mdblistRuntimeMax);
    if (fs.mdblistLanguage) setMdblistLanguage(fs.mdblistLanguage);
    if (fs.mdblistCountry) setMdblistCountry(fs.mdblistCountry);
    if (fs.mdblistGenres) setMdblistGenres(fs.mdblistGenres);
    if (fs.mdblistGenreMode) setMdblistGenreMode(fs.mdblistGenreMode);
    if (fs.mdblistGenreSelection) setMdblistGenreSelection(fs.mdblistGenreSelection);

    toast.info("Template Applied", {
      description: `Pre-populated filters based on ${customizeTemplate.name.replace(' (Custom)', '')}`
    });
  }, [isOpen, customizeTemplate, editingCatalog]);

  useEffect(() => {
    if (!sortOptions.some(option => option.value === sortBy)) {
      setSortBy(sortOptions[0].value);
    }
  }, [sortBy, sortOptions]);

  useEffect(() => {
    if (editingCatalog) return;
    setIncludeGenres([]);
    setExcludeGenres([]);
    setPendingIncludeGenreId('');
    setPendingExcludeGenreId('');
    setCertificationCountry('');
    setCertificationValue('');
    setPeopleQuery('');
    setPeopleResults([]);
    setSelectedPeople([]);
    setPeopleJoinMode('or');
    setCompanyJoinMode('or');
    setKeywordJoinMode('or');
    setActiveSearchDropdown(null);
    setWatchProviders([]);
    setAvailableProviders([]);
    setTvdbStatus('');
    setTvdbYear('');
    setSimklGenre('all');
    setSimklType(getSimklDefaultType(simklMediaType));
    setSimklCountry('all');
    setSimklNetwork('all-networks');
    setSimklYear(getSimklDefaultYear(simklMediaType));
  }, [catalogType, discoverSource, simklMediaType, editingCatalog]);

  useEffect(() => {
    setShowPreview(false);
    setPreviewResults([]);
  }, [discoverParamsPreview]);

  useEffect(() => {
    if (!isOpen) return;

    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedInsideSearch =
        peopleSearchRef.current?.contains(target) ||
        companySearchRef.current?.contains(target) ||
        keywordSearchRef.current?.contains(target);

      if (!clickedInsideSearch) {
        setActiveSearchDropdown(null);
      }
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (!editingCatalog && !customizeTemplate) {
      resetState();
    }
  }, [isOpen, editingCatalog, customizeTemplate]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    const loadReferenceData = async () => {
      setIsLoadingReferences(true);
      try {
        if (discoverSource === 'mal') {
          const cacheKey = 'mal_discover_reference';
          const data = await apiCache.cachedFetch<any>(cacheKey, async () => {
            const response = await fetch('/api/mal/discover/reference');
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.error || `Failed to fetch MAL references (${response.status})`);
            }
            return await response.json();
          }, 30 * 60 * 1000);
          if (cancelled) return;
          if (Array.isArray(data.genres)) {
            setMalAvailableGenres(data.genres.map((g: any) => ({ id: g.mal_id, name: g.name })));
          }
          if (Array.isArray(data.studios)) {
            setMalAvailableStudios(data.studios.map((s: any) => ({
              id: typeof s.mal_id === 'number' ? s.mal_id : s.id,
              name: s.titles?.find((t: any) => t.type === 'Default')?.title || s.name || `Studio ${s.mal_id || s.id}`
            })));
          }
          setReferences(null);
          return;
        }
        if (discoverSource === 'anilist') {
          const cacheKey = 'anilist_discover_reference';
          const data = await apiCache.cachedFetch<any>(cacheKey, async () => {
            const response = await fetch('/api/anilist/discover/reference');
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.error || `Failed to fetch AniList references (${response.status})`);
            }
            return await response.json();
          }, 30 * 60 * 1000);
          if (cancelled) return;
          if (Array.isArray(data.tags)) {
            setAnilistAvailableTags(data.tags.map((t: any) => typeof t === 'string' ? t : t.name));
          }
          setReferences(null);
          return;
        }
        if (discoverSource === 'simkl') {
          setReferences(null);
          return;
        }
        if (discoverSource === 'tmdb') {
          const cacheKey = `tmdb_discover_reference_${tmdbMediaType}_${config.language || 'en-US'}`;
          const data = await apiCache.cachedFetch<TmdbDiscoverReferenceResponse>(
            cacheKey,
            async () => {
              const response = await fetch(
                `/api/tmdb/discover/reference?${buildDiscoverRequestQuery('tmdb', {
                  type: tmdbMediaType,
                  language: config.language || 'en-US'
                })}`
              );
              if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `Failed to fetch discover references (${response.status})`);
              }
              return await response.json();
            },
            30 * 60 * 1000
          );

          if (cancelled) return;

          setReferences({ ...data, source: 'tmdb' });

          if (!editingCatalog) {
            const languageCountryCode = (config.language || 'en-US').split('-')[1];
            if (languageCountryCode) {
              const hasRegion = (data.watchRegions || []).some(
                region => region.iso_3166_1?.toUpperCase() === languageCountryCode.toUpperCase()
              );
              if (hasRegion) {
                setWatchRegion(languageCountryCode.toUpperCase());
              }
            }
          }
          return;
        }

        const cacheKey = `tvdb_discover_reference_v2_${catalogType}_${config.language || 'en-US'}`;
        const data = await apiCache.cachedFetch<any>(
          cacheKey,
          async () => {
            const response = await fetch(
              `/api/tvdb/discover/reference?${buildDiscoverRequestQuery('tvdb', {
                type: catalogType,
                language: config.language || 'en-US'
              })}`
            );
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.error || `Failed to fetch TVDB references (${response.status})`);
            }
            return await response.json();
          },
          30 * 60 * 1000
        );

        if (cancelled) return;

        const certificationMap: Record<string, TmdbCertification[]> = {};
        (Array.isArray(data?.contentRatings) ? data.contentRatings : []).forEach((rating: any) => {
          const ratingId = Number(rating?.id);
          if (!Number.isFinite(ratingId)) return;
          const country = String(rating?.country || data?.defaultCountry || 'usa').toLowerCase();
          if (!certificationMap[country]) {
            certificationMap[country] = [];
          }
          certificationMap[country].push({
            id: ratingId,
            certification: String(ratingId),
            meaning: rating?.fullName || rating?.name || `Rating ${ratingId}`,
            order: Number.isFinite(rating?.order) ? rating.order : undefined
          });
        });

        const mappedReferences: TmdbDiscoverReferenceResponse = {
          source: 'tvdb',
          mediaType: catalogType === 'movie' ? 'movie' : 'tv',
          language: config.language || 'en-US',
          genres: (Array.isArray(data?.genres) ? data.genres : []).map((genre: any) => ({
            id: Number(genre.id),
            name: genre.name || `Genre ${genre.id}`
          })).filter((genre: TmdbGenre) => Number.isFinite(genre.id)),
          languages: (Array.isArray(data?.languages) ? data.languages : []).map((languageItem: any) => {
            const code = resolveTvdbLanguageCode(languageItem);
            return {
              iso_639_1: code,
              english_name: languageItem.name || languageItem.shortCode || languageItem.id || '',
              name: languageItem.nativeName || languageItem.name || languageItem.shortCode || languageItem.id || ''
            };
          }).filter((languageItem: TmdbLanguage) => !!languageItem.iso_639_1),
          countries: (Array.isArray(data?.countries) ? data.countries : []).map((countryItem: any) => {
            const code = resolveTvdbCountryCode(countryItem);
            return {
              iso_3166_1: code,
              english_name: countryItem.name || countryItem.shortCode || countryItem.id || '',
              native_name: countryItem.name || countryItem.shortCode || countryItem.id || ''
            };
          }).filter((countryItem: TmdbCountry) => !!countryItem.iso_3166_1),
          watchRegions: [],
          certifications: certificationMap,
          statuses: (Array.isArray(data?.statuses) ? data.statuses : []).map((status: any) => ({
            id: Number(status.id),
            name: status.name || `Status ${status.id}`
          })).filter((status: { id: number; name: string }) => Number.isFinite(status.id)),
          defaultLanguage: String(data?.defaultLanguage || 'eng').toLowerCase(),
          defaultCountry: String(data?.defaultCountry || 'usa').toLowerCase()
        };

        setReferences(mappedReferences);
        setOriginalLanguage(prev => prev || mappedReferences.defaultLanguage || '');
        setOriginCountry(prev => prev || mappedReferences.defaultCountry || '');
        setCertificationCountry(prev => prev || mappedReferences.defaultCountry || '');
        setCertificationValue('');
        setWatchRegion('');
        setWatchProviders([]);
        setAvailableProviders([]);
      } catch (error) {
        if (cancelled) return;
        const sourceLabel = discoverSource === 'tmdb'
          ? 'TMDB'
          : discoverSource === 'tvdb'
            ? 'TVDB'
            : discoverSource === 'simkl'
              ? 'Simkl'
              : 'AniList';
        console.error(`[${sourceLabel} Discover] Failed to load reference data:`, error);
        toast.error(`Failed to load ${sourceLabel} discover data`, {
          description: error instanceof Error ? error.message : 'Unknown error'
        });
      } finally {
        if (!cancelled) {
          setIsLoadingReferences(false);
        }
      }
    };

    loadReferenceData();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, discoverSource, tmdbMediaType, catalogType, config.language, tmdbApiKey, tvdbApiKey, auth.userUUID]);

  useEffect(() => {
    if (!isOpen || discoverSource !== 'tmdb' || !watchRegion) return;

    let cancelled = false;

    const loadProviders = async () => {
      setIsLoadingProviders(true);
      try {
        const cacheKey = `tmdb_discover_providers_${tmdbMediaType}_${watchRegion}`;
        const data = await apiCache.cachedFetch<{ providers: TmdbProvider[] }>(
          cacheKey,
          async () => {
            const response = await fetch(
              `/api/tmdb/discover/providers?${buildDiscoverRequestQuery('tmdb', {
                type: tmdbMediaType,
                watch_region: watchRegion
              })}`
            );
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.error || `Failed to load providers (${response.status})`);
            }
            return await response.json();
          },
          30 * 60 * 1000
        );

        if (cancelled) return;
        setAvailableProviders(Array.isArray(data.providers) ? data.providers : []);
      } catch (error) {
        if (cancelled) return;
        console.error('[TMDB Discover] Failed to load watch providers:', error);
        toast.error('Failed to load watch providers', {
          description: error instanceof Error ? error.message : 'Unknown error'
        });
      } finally {
        if (!cancelled) setIsLoadingProviders(false);
      }
    };

    loadProviders();

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, discoverSource, watchRegion, tmdbMediaType, tmdbApiKey, auth.userUUID]);

  const searchEntity = async (
    entity: SearchEntity,
    query: string,
    setLoading: React.Dispatch<React.SetStateAction<boolean>>,
    setResults: React.Dispatch<React.SetStateAction<TmdbEntityResult[]>>
  ) => {
    if (!query.trim()) {
      setResults([]);
      setActiveSearchDropdown(prev => (prev === entity ? null : prev));
      return;
    }

    setLoading(true);
    try {
      const normalizedQuery = query.trim();
      if (discoverSource === 'simkl' || discoverSource === 'anilist') {
        setResults([]);
        setActiveSearchDropdown(null);
        return;
      }
      if (discoverSource === 'tvdb' && entity !== 'company') {
        setResults([]);
        setActiveSearchDropdown(null);
        setLoading(false);
        return;
      }

      const endpointBase = discoverSource === 'tmdb' ? '/api/tmdb/discover/search' : '/api/tvdb/discover/search';
      const cacheKey = `${discoverSource}_discover_search_${entity}_${normalizedQuery.toLowerCase()}`;
      const data = await apiCache.cachedFetch<TmdbEntitySearchResponse>(
        cacheKey,
        async () => {
          const response = await fetch(
            `${endpointBase}/${entity}?${buildDiscoverRequestQuery(discoverSource, { query: normalizedQuery })}`
          );
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `Failed to search ${entity} (${response.status})`);
          }
          return await response.json();
        },
        10 * 60 * 1000
      );
      const normalizedResults = Array.isArray(data.results) ? data.results : [];
      setResults(normalizedResults);
      setActiveSearchDropdown(normalizedResults.length > 0 ? entity : null);
    } catch (error) {
      const sourceLabel = discoverSource === 'tmdb' ? 'TMDB' : discoverSource === 'tvdb' ? 'TVDB' : 'Simkl';
      console.error(`[${sourceLabel} Discover] Failed to search ${entity}:`, error);
      toast.error(`Failed to search ${entity}`, {
        description: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setLoading(false);
    }
  };

  const searchAnilistStudios = async (query: string) => {
    if (!query.trim()) {
      setAnilistStudioResults([]);
      return;
    }
    setIsSearchingStudios(true);
    try {
      const cacheKey = `anilist_studio_search_${query.toLowerCase().trim()}`;
      const data = await apiCache.cachedFetch<any>(cacheKey, async () => {
        const response = await fetch(`/api/anilist/discover/search/studio?query=${encodeURIComponent(query.trim())}`);
        if (!response.ok) throw new Error('Failed to search studios');
        return await response.json();
      }, 10 * 60 * 1000);
      setAnilistStudioResults(Array.isArray(data.results) ? data.results : []);
    } catch (error) {
      console.error('[AniList Discover] Studio search failed:', error);
      toast.error('Failed to search studios');
    } finally {
      setIsSearchingStudios(false);
    }
  };

  const searchMalStudios = async (query: string) => {
    if (!query.trim()) {
      setMalStudioResults([]);
      return;
    }
    setIsSearchingMalStudios(true);
    try {
      const cacheKey = `mal_studio_search_${query.toLowerCase().trim()}`;
      const data = await apiCache.cachedFetch<any>(cacheKey, async () => {
        const response = await fetch(`/api/mal/discover/search/producer?query=${encodeURIComponent(query.trim())}`);
        if (!response.ok) throw new Error('Failed to search MAL producers');
        return await response.json();
      }, 10 * 60 * 1000);
      setMalStudioResults(Array.isArray(data.results) ? data.results : []);
    } catch (error) {
      console.error('[MAL Discover] Studio search failed:', error);
      toast.error('Failed to search studios');
    } finally {
      setIsSearchingMalStudios(false);
    }
  };

  const toSelectionItem = (item: TmdbEntityResult): SelectionItem => ({
    id: item.id,
    label: item.name || item.title || `ID ${item.id}`
  });

  const handlePreview = async () => {
    setIsPreviewLoading(true);
    setShowPreview(true);
    try {
      const params = buildDiscoverParams();
      let results: any[] = [];
      let totalResults = 0;
  
      if (discoverSource === 'tmdb') {
        const mediaType = catalogType === 'movie' ? 'movie' : 'tv';
        const queryParams = new URLSearchParams();
        queryParams.set('type', mediaType);
        for (const [key, value] of Object.entries(params)) {
          queryParams.set(key, String(value));
        }
        if (config.apiKeys?.tmdb) queryParams.set('apikey', config.apiKeys.tmdb);
        if (auth.userUUID) queryParams.set('userUUID', auth.userUUID);
  
        const res = await fetch(`/api/tmdb/discover/preview?${queryParams.toString()}`);
        const data = await res.json();
        results = data.results || [];
        totalResults = data.total_results || 0;
  
      } else if (discoverSource === 'tvdb') {
        const queryParams = new URLSearchParams();
        queryParams.set('type', catalogType);
        for (const [key, value] of Object.entries(params)) {
          queryParams.set(key, String(value));
        }
        if (config.apiKeys?.tvdb) queryParams.set('apikey', config.apiKeys.tvdb);
        if (auth.userUUID) queryParams.set('userUUID', auth.userUUID);
        const res = await fetch(`/api/tvdb/discover/preview?${queryParams.toString()}`);
        const data = await res.json();
        results = data.results || [];
        totalResults = data.total_results || 0;
  
      } else if (discoverSource === 'anilist') {
        const res = await fetch('/api/anilist/discover/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ params }),
        });
        const data = await res.json();
        results = data.results || [];
        totalResults = data.total_results || 0;
      } else if (discoverSource === 'simkl') {
        const queryParams = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          queryParams.set(key, String(value));
        }
        const res = await fetch(`/api/simkl/discover/preview?${queryParams.toString()}`);
        const data = await res.json();
        results = data.results || [];
        totalResults = data.total_results || 0;
      
      } else if (discoverSource === 'mal') {
        const queryParams = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          queryParams.set(key, String(value));
        }
        const res = await fetch(`/api/mal/discover/preview?${queryParams.toString()}`);
        const data = await res.json();
        results = data.results || [];
        totalResults = data.total_results || 0;

      } else if (discoverSource === 'mdblist') {
        // Check if user already opted in to skip the confirmation
        const skipConfirm = localStorage.getItem('mdblist-preview-confirmed') === 'true';
        if (!skipConfirm) {
          // Show confirmation dialog and bail — the actual fetch happens in executeMdblistPreview
          setShowMdblistPreviewConfirm(true);
          setIsPreviewLoading(false);
          return;
        }
        const mdblistData = await executeMdblistPreview(params);
        results = mdblistData.results;
        totalResults = mdblistData.totalResults;
      }
  
      setPreviewResults(results);
      setPreviewTotalResults(totalResults);
    } catch (error) {
      console.error('Preview failed:', error);
      toast.error('Preview failed', {
        description: error instanceof Error ? error.message : 'Unknown error'
      });
      setPreviewResults([]);
      setPreviewTotalResults(0);
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const executeMdblistPreview = async (params?: Record<string, string | number | boolean>) => {
    const p = params || buildDiscoverParams();
    setIsPreviewLoading(true);
    setShowPreview(true);
    try {
      const queryParams = new URLSearchParams();
      const mediaType = catalogType === 'movie' ? 'movie' : 'show';
      queryParams.set('mediaType', mediaType);
      for (const [key, value] of Object.entries(p)) {
        queryParams.set(key, String(value));
      }
      if (config.apiKeys?.mdblist) queryParams.set('apikey', config.apiKeys.mdblist);
      const res = await fetch(`/api/mdblist/discover/preview?${queryParams.toString()}`);
      const data = await res.json();
      const results = data.results || [];
      const totalResults = data.total_results || 0;
      setPreviewResults(results);
      setPreviewTotalResults(totalResults);
      return { results, totalResults };
    } catch (error) {
      console.error('MDBList preview failed:', error);
      toast.error('Preview failed', {
        description: error instanceof Error ? error.message : 'Unknown error'
      });
      setPreviewResults([]);
      setPreviewTotalResults(0);
      return { results: [], totalResults: 0 };
    } finally {
      setIsPreviewLoading(false);
    }
  };

  function buildDiscoverParams(): Record<string, string | number | boolean> {

    if (discoverSource === 'mdblist') {
      const p: Record<string, string | number | boolean> = {
        sort: sortBy,
        sort_order: mdblistSortDirection,
      };
      if (mdblistScoreMin > 0) p.score_min = mdblistScoreMin;
      if (mdblistScoreMax < 100) p.score_max = mdblistScoreMax;
      if (mdblistYearMin) p.year_min = parseInt(mdblistYearMin);
      if (mdblistYearMax) p.year_max = parseInt(mdblistYearMax);
      if (mdblistReleasedFrom) p.released_from = mdblistReleasedFrom;
      if (mdblistReleasedTo) p.released_to = mdblistReleasedTo;
      if (mdblistRuntimeMin) p.runtime_min = parseInt(mdblistRuntimeMin);
      if (mdblistRuntimeMax) p.runtime_max = parseInt(mdblistRuntimeMax);
      if (mdblistLanguage) p.language = mdblistLanguage;
      if (mdblistCountry) p.country = mdblistCountry;
      if (mdblistGenres.length > 0) p.genre = mdblistGenres.join(',');
      if (mdblistGenres.length > 1) p.genre_mode = mdblistGenreMode;
      return p;
    }

    if (discoverSource === 'simkl') {
      const simklParams: Record<string, string | number | boolean> = {
        media: simklMediaType,
        sort: sortBy,
      };

      if (simklGenre && simklGenre !== 'all') {
        simklParams.genre = simklGenre;
      }

      if (simklMediaType !== 'movies' && simklType && simklType !== getSimklDefaultType(simklMediaType)) {
        simklParams.type = simklType;
      }

      if (simklMediaType !== 'anime' && simklCountry && simklCountry !== 'all') {
        simklParams.country = simklCountry;
      }

      if (simklMediaType !== 'movies' && simklNetwork && simklNetwork !== 'all-networks') {
        simklParams.network = simklNetwork;
      }

      if (simklYear && simklYear !== getSimklDefaultYear(simklMediaType)) {
        simklParams.year = simklYear;
      }

      return simklParams;
    }

    if (discoverSource === 'mal') {
      const malParams: Record<string, string | number | boolean> = {
        order_by: sortBy,
        sort: malSortDirection,
      };
      if (malType) malParams.type = malType;

      if (malStatus) malParams.status = malStatus;
      if (malRating) malParams.rating = malRating;
      if (malIncludeGenreIds.length > 0) {
        malParams.genres = malIncludeGenreIds.map(g => g.id).join(',');
      }
      if (malExcludeGenreIds.length > 0) {
        malParams.genres_exclude = malExcludeGenreIds.map(g => g.id).join(',');
      }
      if (malProducers.length > 0) {
        malParams.producers = malProducers.map(p => p.id).join(',');
      }
      if (malMinScore > 0) malParams.min_score = malMinScore;
      if (malMaxScore < 10) malParams.max_score = malMaxScore;
      if (malStartDate) malParams.start_date = malStartDate;
      if (malEndDate) malParams.end_date = malEndDate;
      if (malSfw) malParams.sfw = true;
      return malParams;
    }

    if (discoverSource === 'anilist') {
      const anilistParams: Record<string, string | number | boolean> = {
        sort: sortBy,
      };
      // Multi-format: join selected formats with comma
      if (anilistFormats.length > 0) {
        anilistParams.format_in = anilistFormats.join(',');
      }
      if (anilistStatus) anilistParams.status = anilistStatus;
      if (anilistSeason) anilistParams.season = anilistSeason;
      if (anilistSeasonYear) {
        const year = Number(anilistSeasonYear);
        if (Number.isFinite(year) && year > 0) anilistParams.seasonYear = year;
      }
      if (anilistCountry) anilistParams.countryOfOrigin = anilistCountry;
      if (anilistSelectedStudios.length > 0) {
        anilistParams.studios = anilistSelectedStudios.map(s => s.id).join(',');
      }
      if (anilistIncludeGenres.length > 0) anilistParams.genre_in = anilistIncludeGenres.join(',');
      if (anilistExcludeGenres.length > 0) anilistParams.genre_not_in = anilistExcludeGenres.join(',');
      if (anilistIncludeTags.length > 0) anilistParams.tag_in = anilistIncludeTags.join(',');
      if (anilistExcludeTags.length > 0) anilistParams.tag_not_in = anilistExcludeTags.join(',');
      if (anilistScoreRange[0] > 0) anilistParams.averageScore_greater = anilistScoreRange[0];
      if (anilistScoreRange[1] < 100) anilistParams.averageScore_lesser = anilistScoreRange[1];
      if (anilistPopularityMin > 0) anilistParams.popularity_greater = anilistPopularityMin;
      if (anilistEpisodesRange[0] > 0) anilistParams.episodes_greater = anilistEpisodesRange[0];
      if (anilistEpisodesRange[1] < 200) anilistParams.episodes_lesser = anilistEpisodesRange[1];
      if (anilistDurationRange[0] > 0) anilistParams.duration_greater = anilistDurationRange[0];
      if (anilistDurationRange[1] < 180) anilistParams.duration_lesser = anilistDurationRange[1];
      if (!anilistIsAdult) anilistParams.isAdult = false;
      if (anilistStartDateFrom) anilistParams.startDate_greater = anilistStartDateFrom.replace(/-/g, '');
      if (anilistStartDateTo) anilistParams.startDate_lesser = anilistStartDateTo.replace(/-/g, '');
      return anilistParams;
    }

    if (discoverSource === 'tvdb') {
      const tvdbParams: Record<string, string | number | boolean> = {
        sort: sortBy,
        country: (originCountry || 'usa' || references?.defaultCountry || 'usa').toLowerCase(),
        lang: (originalLanguage || references?.defaultLanguage || 'eng').toLowerCase(),
      };

      if (catalogType === 'series') {
        tvdbParams.sortType = tvdbSortDirection;
      }

      if (includeGenres.length > 0) {
        tvdbParams.genre = includeGenres[0].id;
      }
      if (withCompanies.length > 0) {
        tvdbParams.company = withCompanies[0].id;
      }
      if (certificationValue) {
        const ratingId = Number(certificationValue);
        if (Number.isFinite(ratingId)) {
          tvdbParams.contentRating = Math.floor(ratingId);
        }
      }
      if (tvdbStatus) {
        const statusId = Number(tvdbStatus);
        if (Number.isFinite(statusId)) {
          tvdbParams.status = Math.floor(statusId);
        }
      }
      if (tvdbYear) {
        const parsedYear = Number(tvdbYear);
        if (Number.isFinite(parsedYear) && parsedYear > 0) {
          tvdbParams.year = Math.floor(parsedYear);
        }
      }

      return tvdbParams;
    }

    const params: Record<string, string | number | boolean> = {
      sort_by: sortBy,
      include_adult: includeAdult
    };

    if (includeGenres.length > 0) {
      params.with_genres = joinSelectionValues(includeGenres, genreJoinMode);
    }
    if (excludeGenres.length > 0) {
      params.without_genres = joinSelectionValues(excludeGenres, genreJoinMode);
    }

    if (originalLanguage) {
      params.with_original_language = originalLanguage;
    }
    if (originCountry) {
      params.with_origin_country = originCountry;
    }

    if (catalogType === 'movie' && certificationCountry && certificationValue) {
      params.certification_country = certificationCountry;
      params.certification = certificationValue;
    }

    if (catalogType === 'movie' && selectedPeople.length > 0) {
      params.with_people = joinSelectionValues(selectedPeople, peopleJoinMode);
    }

    if (withCompanies.length > 0) {
      params.with_companies = joinSelectionValues(withCompanies, companyJoinMode);
    }
    if (withoutCompanies.length > 0) {
      params.without_companies = joinSelectionValues(withoutCompanies, companyJoinMode);
    }

    if (withKeywords.length > 0) {
      params.with_keywords = joinSelectionValues(withKeywords, keywordJoinMode);
    }
    if (withoutKeywords.length > 0) {
      params.without_keywords = joinSelectionValues(withoutKeywords, keywordJoinMode);
    }

    if (watchRegion) {
      params.watch_region = watchRegion;
    }
    if (watchProviders.length > 0) {
      params.with_watch_providers = joinSelectionValues(watchProviders, providerJoinMode);
      params.with_watch_monetization_types = 'flatrate|free|ads|rent|buy';
    }

    if (catalogType === 'movie' && releaseRegion) {
      params.region = releaseRegion;
    }
    if (catalogType === 'movie' && releasedOnly) {
      // Home release channels only: digital, physical, or TV.
      params.with_release_type = '4|5|6';
      params['release_date.lte'] = getTodayLocalDateString();
    } else if (catalogType === 'series' && releasedOnly) {
      // Exclude planned/in-production series. Keep statuses that indicate released content.
      params.with_status = '0|3|4|5';
    }

    const [voteAverageMin, voteAverageMax] = voteAverageRange;
    const [runtimeMin, runtimeMax] = runtimeRange;

    if (voteAverageMin > 0) {
      params['vote_average.gte'] = Math.max(0, Math.min(10, voteAverageMin));
    }
    if (voteAverageMax < 10) {
      params['vote_average.lte'] = Math.max(0, Math.min(10, voteAverageMax));
    }
    if (voteCountMin > 0) {
      params['vote_count.gte'] = Math.max(0, Math.floor(voteCountMin));
    }
    if (runtimeMin > 0) {
      params['with_runtime.gte'] = Math.max(0, Math.floor(runtimeMin));
    }
    if (runtimeMax < MAX_RUNTIME_MINUTES) {
      params['with_runtime.lte'] = Math.max(0, Math.floor(runtimeMax));
    }

    if (catalogType === 'movie') {
      if (primaryReleaseFrom) params['primary_release_date.gte'] = primaryReleaseFrom;
      if (primaryReleaseTo) params['primary_release_date.lte'] = primaryReleaseTo;
    } else {
      if (firstAirFrom) params['first_air_date.gte'] = firstAirFrom;
      if (firstAirTo) params['first_air_date.lte'] = firstAirTo;
      if (airDateFrom) params['air_date.gte'] = airDateFrom;
      if (airDateTo) params['air_date.lte'] = airDateTo;
    }

    return params;
  }

  function buildFormState(): Record<string, any> {
    const state: Record<string, any> = {
      // Shared
      catalogName: catalogName.trim(),
      discoverSource,
      sortBy,
      cacheTTL,
      catalogType,
    };
  
    // TMDB / TVDB shared
    if (discoverSource === 'tmdb' || discoverSource === 'tvdb') {
      Object.assign(state, {
        includeGenres,
        excludeGenres,
        genreJoinMode,
        originalLanguage,
        originCountry,
        certificationCountry,
        certificationValue,
      });
    }
  
    // TMDB-only
    if (discoverSource === 'tmdb') {
      Object.assign(state, {
        includeAdult,
        releasedOnly,
        selectedPeople,
        peopleJoinMode,
        withCompanies,
        withoutCompanies,
        companyJoinMode,
        withKeywords,
        withoutKeywords,
        keywordJoinMode,
        watchRegion,
        watchProviders,
        providerJoinMode,
        voteAverageRange,
        voteCountMin,
        runtimeRange,
        primaryReleaseFrom,
        primaryReleaseTo,
        movieDatePreset,
        firstAirFrom,
        firstAirTo,
        seriesDatePreset,
        airDateFrom,
        airDateTo,
        releaseRegion,
      });
    }
  
    // TVDB-only
    if (discoverSource === 'tvdb') {
      Object.assign(state, {
        tvdbSortDirection,
        tvdbStatus,
        tvdbYear,
      });
    }
  
    // Simkl
    if (discoverSource === 'simkl') {
      Object.assign(state, {
        simklMediaType,
        simklGenre,
        simklType,
        simklCountry,
        simklNetwork,
        simklYear,
      });
    }
  
    // AniList
    if (discoverSource === 'anilist') {
      Object.assign(state, {
        anilistFormats,
        anilistStatus,
        anilistSeason,
        anilistSeasonYear,
        anilistCountry,
        anilistSelectedStudios,
        anilistIncludeGenres,
        anilistExcludeGenres,
        anilistIncludeTags,
        anilistExcludeTags,
        anilistScoreRange,
        anilistPopularityMin,
        anilistEpisodesRange,
        anilistDurationRange,
        anilistIsAdult,
        anilistStartDateFrom,
        anilistStartDateTo,
      });
    }
  
    // MAL
    if (discoverSource === 'mal') {
      Object.assign(state, {
        malType,
        malStatus,
        malRating,
        malSortDirection,
        malIncludeGenreIds,
        malExcludeGenreIds,
        malProducers,
        malMinScore,
        malMaxScore,
        malStartDate,
        malEndDate,
        malSfw,
      });
    }

    // MDBList
    if (discoverSource === 'mdblist') {
      Object.assign(state, {
        mdblistSortDirection,
        mdblistScoreMin,
        mdblistScoreMax,
        mdblistYearMin,
        mdblistYearMax,
        mdblistReleasedFrom,
        mdblistReleasedTo,
        mdblistRuntimeMin,
        mdblistRuntimeMax,
        mdblistLanguage,
        mdblistCountry,
        mdblistGenres,
        mdblistGenreMode,
        mdblistGenreSelection,
      });
    }

    return state;
  }

  const handleVoteAverageMinSliderChange = (value: number) => {
    setVoteAverageRange(([_, currentMax]) => [Math.min(value, currentMax), currentMax]);
  };

  const handleVoteAverageMaxSliderChange = (value: number) => {
    setVoteAverageRange(([currentMin]) => [currentMin, Math.max(value, currentMin)]);
  };

  const handleRuntimeMinSliderChange = (value: number) => {
    setRuntimeRange(([_, currentMax]) => [Math.min(value, currentMax), currentMax]);
  };

  const handleRuntimeMaxSliderChange = (value: number) => {
    setRuntimeRange(([currentMin]) => [currentMin, Math.max(value, currentMin)]);
  };

  const applyDatePreset = (target: 'movie' | 'series', preset: Exclude<DatePresetKey, 'custom'>) => {
    const { from, to } = getDateRangeFromPreset(preset);

    if (target === 'movie') {
      setPrimaryReleaseFrom(from);
      setPrimaryReleaseTo(to);
      setMovieDatePreset(preset);
      return;
    }

    setFirstAirFrom(from);
    setFirstAirTo(to);
    setSeriesDatePreset(preset);
  };

  const handleAddGenre = (mode: 'include' | 'exclude', selectedGenreId?: string) => {
    const genreId = selectedGenreId ?? (mode === 'include' ? pendingIncludeGenreId : pendingExcludeGenreId);
    if (!genreId) return;

    const genre = sortedGenres.find(item => String(item.id) === genreId);
    if (!genre) return;

    const selection: SelectionItem = { id: genre.id, label: genre.name };
    if (mode === 'include') {
      setIncludeGenres(prev => addUniqueItem(prev, selection));
      setExcludeGenres(prev => removeItemById(prev, selection.id));
      setPendingIncludeGenreId('');
    } else {
      setExcludeGenres(prev => addUniqueItem(prev, selection));
      setIncludeGenres(prev => removeItemById(prev, selection.id));
      setPendingExcludeGenreId('');
    }
  };

  const handleToggleProvider = (provider: TmdbProvider) => {
    const selection: SelectionItem = { id: provider.provider_id, label: provider.provider_name };
    setWatchProviders(prev => {
      if (prev.some(item => item.id === provider.provider_id)) {
        return prev.filter(item => item.id !== provider.provider_id);
      }
      return [...prev, selection];
    });
  };

  const handleCreateCatalog = () => {
    if (!catalogName.trim()) {
      toast.error('Catalog name is required');
      return;
    }
  
    setIsSaving(true);
    try {
      const params = buildDiscoverParams();
      const persistedParams = discoverSource === 'tmdb'
        ? applyDynamicTmdbDateTokens(params, catalogType, movieDatePreset, seriesDatePreset, releasedOnly)
        : params;
      const formState = buildFormState();
  
      // Reuse existing ID when editing, generate new one when creating
      let catalogId: string;
      if (editingCatalog) {
        catalogId = editingCatalog.id;
      } else {
        const sanitizedName = catalogName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 40) || 'catalog';
        const uniqueSuffix = Date.now().toString(36);
        const SOURCE_PREFIXES: Record<string, string> = {
          tmdb: 'tmdb.discover',
          tvdb: 'tvdb.discover',
          simkl: 'simkl.discover',
          mal: 'mal.discover',
          anilist: 'anilist.discover',
          mdblist: 'mdblist.discover',
        };
        const sourcePrefix = SOURCE_PREFIXES[discoverSource] ?? 'tmdb.discover';
        const catalogTypeSegment = discoverSource === 'simkl'
          ? simklMediaType
          : discoverSource === 'anilist' || discoverSource === 'mal'
            ? 'anime'
            : catalogType;
        catalogId = `${sourcePrefix}.${catalogTypeSegment}.${sanitizedName}.${uniqueSuffix}`;
      }
  
      const simklCatalogType = simklMediaType === 'movies' ? 'movie'
        : simklMediaType === 'shows' ? 'series' : 'anime';
  
      const displayType = discoverSource === 'simkl' && simklCatalogType === 'anime'
        ? undefined
        : getDisplayTypeOverride(
            discoverSource === 'simkl'
              ? (simklCatalogType === 'movie' ? 'movie' : 'series')
              : catalogType,
            config.displayTypeOverrides
          );
  
      const SOURCE_LABELS: Record<string, string> = {
        tmdb: 'TMDB', tvdb: 'TVDB', simkl: 'SIMKL', mal: 'MAL', anilist: 'ANILIST', mdblist: 'MDBLIST',
      };
      const sourceLabel = SOURCE_LABELS[discoverSource] ?? 'TMDB';
  
      const discoverMediaType = discoverSource === 'tmdb'
        ? tmdbMediaType
        : (discoverSource === 'anilist' || discoverSource === 'mal')
          ? 'anime'
          : discoverSource === 'simkl'
            ? simklCatalogType
            : catalogType;
  
      const discoverUrl = discoverSource === 'tmdb'
        ? buildTmdbDiscoverWebUrl(tmdbMediaType, params)
        : discoverSource === 'tvdb'
          ? buildTvdbDiscoverApiUrl(catalogType, params)
          : discoverSource === 'simkl'
            ? buildSimklDiscoverApiUrl(simklMediaType, params)
            : discoverSource === 'mal'
              ? `https://myanimelist.net/anime.php`
              : discoverSource === 'mdblist'
                ? `https://mdblist.com`
                : `https://anilist.co/search/anime`;
  
      const newCatalog: CatalogConfig = {
        id: catalogId,
        type: (discoverSource === 'anilist' || discoverSource === 'mal')
          ? 'anime'
          : discoverSource === 'simkl' ? simklCatalogType : catalogType,
        name: catalogName.trim(),
        enabled: editingCatalog?.enabled ?? true,
        showInHome: editingCatalog?.showInHome ?? true,
        source: discoverSource,
        cacheTTL: Math.max(cacheTTL, 300),
        // Preserve existing settings when editing
        ...(editingCatalog?.enableRatingPosters !== undefined && {
          enableRatingPosters: editingCatalog.enableRatingPosters
        }),
        ...(editingCatalog?.randomizePerPage !== undefined && {
          randomizePerPage: editingCatalog.randomizePerPage
        }),
        ...(displayType && { displayType }),
        metadata: {
          description: `${sourceLabel} Discover (${discoverMediaType})`,
          url: discoverUrl,
          discover: {
            version: 2,
            source: discoverSource,
            mediaType: discoverMediaType as 'movie' | 'tv' | 'series' | 'anime',
            params: persistedParams,
            formState,
          }
        }
      };
  
      if (editingCatalog) {
        // Update in-place
        setConfig(prev => ({
          ...prev,
          catalogs: prev.catalogs.map(c =>
            c.id === editingCatalog.id && c.type === editingCatalog.type
              ? newCatalog
              : c
          ),
        }));
        toast.success('Catalog updated', {
          description: `${catalogName.trim()} has been updated`
        });
      } else {
        // Create new
        setConfig(prev => ({
          ...prev,
          catalogs: [...prev.catalogs, newCatalog]
        }));
        toast.success('Custom catalog created', {
          description: `${catalogName.trim()} was added to your ${sourceLabel} catalogs`
        });
      }
  
      resetState();
      onClose();
    } catch (error) {
      console.error(`[Discover] Failed to save catalog:`, error);
      toast.error('Failed to save catalog', {
        description: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const renderSelectedItems = (
    items: SelectionItem[],
    onRemove: (id: number) => void,
    emptyLabel: string
  ) => {
    if (items.length === 0) {
      return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
    }

    return (
      <div className="flex flex-wrap gap-2">
        {items.map(item => (
          <Badge key={item.id} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
            <span className="max-w-[180px] truncate">{item.label}</span>
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className="rounded-sm p-0.5 hover:bg-background/50"
              aria-label={`Remove ${item.label}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
    );
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          className="max-w-5xl max-h-[90vh] overflow-y-auto"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-5 w-5" />
            {editingCatalog 
              ? 'Edit Catalog' 
              : customizeTemplate 
                ? `Customize ${customizeTemplate.name.replace(' (Custom)', '')}` 
                : 'Build Your Catalog'}
          </DialogTitle>
              <DialogDescription>
              Create custom TMDB, TVDB, Simkl, or AniList discover catalogs with filters and save them directly into your catalog list.
              </DialogDescription>
          </DialogHeader>

        {!activeSourceApiKey && discoverSource !== 'anilist' && discoverSource !== 'mal' && discoverSource !== 'simkl' && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
            <AlertCircle className="h-5 w-5 text-yellow-500 mt-0.5 flex-shrink-0" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Using Server {sourceLabel} Key Fallback</p>
              <p className="text-xs text-muted-foreground">
                Your personal {sourceLabel} key is empty. Requests will use server fallbacks
                {discoverSource === 'tmdb'
                  ? (<>{' '}(<code>TMDB_API</code>, then <code>BUILT_IN_TMDB_API_KEY</code>)</>)
                  : discoverSource === 'tvdb'
                    ? (<>{' '}(<code>TVDB_API_KEY</code>, then <code>BUILT_IN_TVDB_API_KEY</code>)</>)
                    : (<>{' '}(<code>SIMKL_CLIENT_ID</code>)</>)}
                {' '}when available.
              </p>
              <p className="text-xs text-muted-foreground">
                If your server has no {sourceLabel} fallback configured, discover requests will fail.
              </p>
            </div>
          </div>
        )}

        <div className="space-y-5 py-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Catalog Setup</CardTitle>
                <CardDescription>
                  Configure the catalog identity, sorting, and cache behavior.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="discover-name">Catalog Name</Label>
                    <Input
                      id="discover-name"
                      placeholder="e.g. Cyberpunk Essentials"
                      value={catalogName}
                      onChange={(event) => setCatalogName(event.target.value)}
                      maxLength={80}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Source</Label>
                    <Select value={discoverSource} onValueChange={(value: DiscoverSource) => setDiscoverSource(value)} disabled={!!editingCatalog || !!customizeTemplate}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tmdb">TMDB</SelectItem>
                        <SelectItem value="tvdb">TVDB</SelectItem>
                        <SelectItem value="simkl" disabled={!hasSimklClientId}>
                          {hasSimklClientId ? 'Simkl' : 'Simkl (Disabled)'}
                        </SelectItem>
                        <SelectItem value="anilist">AniList</SelectItem>
                        <SelectItem value="mal">MAL</SelectItem>
                        <SelectItem value="mdblist" disabled={!hasMdblistApiKey}>
                          {hasMdblistApiKey ? 'MDBList' : 'MDBList (No API Key)'}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Content Type</Label>
                    {(discoverSource === 'anilist' || discoverSource === 'mal') ? (
                    <div className="flex h-10 items-center rounded-md border border-input bg-muted/50 px-3 text-sm">Anime</div>
                    ) : discoverSource === 'simkl' ? (
                      <Select value={simklMediaType} onValueChange={(value: SimklDiscoverMediaType) => setSimklMediaType(value)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SIMKL_MEDIA_OPTIONS.map(option => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select value={catalogType} onValueChange={(value: CatalogMediaType) => setCatalogType(value)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="movie">Movies</SelectItem>
                          <SelectItem value="series">Series</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>Sort By</Label>
                    <Select value={sortBy} onValueChange={setSortBy}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sortOptions.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {discoverSource === 'tvdb' && catalogType === 'series' && (
                    <div className="space-y-2">
                      <Label>Sort Direction</Label>
                      <Select value={tvdbSortDirection} onValueChange={(value: 'asc' | 'desc') => setTvdbSortDirection(value)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TVDB_SORT_DIRECTION_OPTIONS.map(option => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {discoverSource === 'anilist' && (
                    <>
                    <div className="space-y-2">
                      <Label>Format (select multiple)</Label>
                      <div className="flex flex-wrap gap-2">
                        {ANILIST_FORMAT_OPTIONS.map(option => {
                          const selected = anilistFormats.includes(option.value);
                          return (
                            <Button
                              key={option.value} type="button" size="sm"
                              variant={selected ? 'default' : 'outline'}
                              onClick={() => setAnilistFormats(prev =>
                                selected ? prev.filter(f => f !== option.value) : [...prev, option.value]
                              )}
                            >
                              {option.label}
                            </Button>
                          );
                        })}
                      </div>
                      {anilistFormats.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Selected: {anilistFormats.map(f => ANILIST_FORMAT_OPTIONS.find(o => o.value === f)?.label || f).join(', ')}
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Airing Status</Label>
                        <Select value={anilistStatus || NONE_VALUE} onValueChange={(v) => setAnilistStatus(v === NONE_VALUE ? '' : v)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE_VALUE}>Any</SelectItem>
                            {ANILIST_STATUS_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Season</Label>
                        <Select value={anilistSeason || NONE_VALUE} onValueChange={(v) => setAnilistSeason(v === NONE_VALUE ? '' : v)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE_VALUE}>Any</SelectItem>
                            {ANILIST_SEASON_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="anilist-season-year">Season Year</Label>
                        <Input id="anilist-season-year" type="number" min={1900} max={2100} placeholder="Any" value={anilistSeasonYear} onChange={(e) => setAnilistSeasonYear(e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>Country of Origin</Label>
                        <Select value={anilistCountry || NONE_VALUE} onValueChange={(v) => setAnilistCountry(v === NONE_VALUE ? '' : v)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE_VALUE}>Any</SelectItem>
                            {ANILIST_COUNTRY_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </>
                  )}
                  {discoverSource === 'mal' && (
                  <div className="space-y-4">
                    {/* Sort Direction */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Sort Direction</Label>
                        <Select value={malSortDirection} onValueChange={setMalSortDirection}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {MAL_SORT_DIRECTION_OPTIONS.map(o => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Airing Status */}
                      <div className="space-y-2">
                        <Label>Airing Status</Label>
                        <Select value={malStatus || NONE_VALUE} onValueChange={(v) => setMalStatus(v === NONE_VALUE ? '' : v)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE_VALUE}>Any</SelectItem>
                            {MAL_STATUS_OPTIONS.map(o => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {/* Type (multi-select toggle buttons) */}
                    <div className="space-y-2">
                      <Label>Type</Label>
                      <Select value={malType || NONE_VALUE} onValueChange={(v) => setMalType(v === NONE_VALUE ? '' : v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE_VALUE}>Any</SelectItem>
                          {MAL_TYPE_OPTIONS.map(o => (
                            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Rating */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Content Rating</Label>
                        <Select value={malRating || NONE_VALUE} onValueChange={(v) => setMalRating(v === NONE_VALUE ? '' : v)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE_VALUE}>Any</SelectItem>
                            {MAL_RATING_OPTIONS.map(o => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* SFW toggle */}
                      <div className="flex items-center justify-between rounded-md border p-3">
                        <div>
                          <Label className="text-sm">Safe for Work</Label>
                          <p className="text-xs text-muted-foreground">Filter NSFW results.</p>
                        </div>
                        <Switch checked={malSfw} onCheckedChange={setMalSfw} />
                      </div>
                    </div>
                  </div>
                  )}
                  {discoverSource === 'mal' && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Genres</CardTitle>
                      <CardDescription>Include or exclude MAL genre categories.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {malAvailableGenres.length === 0 ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading MAL genres...
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {/* Include Genres */}
                          <div className="space-y-2">
                            <Label>Include Genres</Label>
                            <Select
                              value=""
                              onValueChange={(value) => {
                                const genre = malAvailableGenres.find(g => String(g.id) === value);
                                if (genre && !malIncludeGenreIds.find(g => g.id === genre.id)) {
                                  setMalIncludeGenreIds(prev => [...prev, { id: genre.id, label: genre.name }]);
                                  setMalExcludeGenreIds(prev => prev.filter(g => g.id !== genre.id));
                                }
                              }}
                            >
                              <SelectTrigger><SelectValue placeholder="Select genre to include" /></SelectTrigger>
                              <SelectContent>
                                {malAvailableGenres
                                  .filter(g => !malIncludeGenreIds.find(ig => ig.id === g.id))
                                  .map(genre => (
                                    <SelectItem key={genre.id} value={String(genre.id)}>{genre.name}</SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                            {malIncludeGenreIds.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {malIncludeGenreIds.map(genre => (
                                  <Badge key={genre.id} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
                                    <span className="max-w-[180px] truncate">{genre.label}</span>
                                    <button
                                      type="button"
                                      onClick={() => setMalIncludeGenreIds(prev => prev.filter(g => g.id !== genre.id))}
                                      className="rounded-sm p-0.5 hover:bg-background/50"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-muted-foreground">No included genres</p>
                            )}
                          </div>

                          {/* Exclude Genres */}
                          <div className="space-y-2">
                            <Label>Exclude Genres</Label>
                            <Select
                              value=""
                              onValueChange={(value) => {
                                const genre = malAvailableGenres.find(g => String(g.id) === value);
                                if (genre && !malExcludeGenreIds.find(g => g.id === genre.id)) {
                                  setMalExcludeGenreIds(prev => [...prev, { id: genre.id, label: genre.name }]);
                                  setMalIncludeGenreIds(prev => prev.filter(g => g.id !== genre.id));
                                }
                              }}
                            >
                              <SelectTrigger><SelectValue placeholder="Select genre to exclude" /></SelectTrigger>
                              <SelectContent>
                                {malAvailableGenres
                                  .filter(g => !malExcludeGenreIds.find(eg => eg.id === g.id))
                                  .map(genre => (
                                    <SelectItem key={genre.id} value={String(genre.id)}>{genre.name}</SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                            {malExcludeGenreIds.length > 0 ? (
                              <div className="flex flex-wrap gap-2">
                                {malExcludeGenreIds.map(genre => (
                                  <Badge key={genre.id} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
                                    <span className="max-w-[180px] truncate">{genre.label}</span>
                                    <button
                                      type="button"
                                      onClick={() => setMalExcludeGenreIds(prev => prev.filter(g => g.id !== genre.id))}
                                      className="rounded-sm p-0.5 hover:bg-background/50"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <p className="text-xs text-muted-foreground">No excluded genres</p>
                            )}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                  )}
                  {discoverSource === 'mal' && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Studio / Producer</CardTitle>
                      <CardDescription>Filter by anime studio or production company.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex gap-2">
                        <Input
                          placeholder="Search studio (e.g. MAPPA, Bones, ufotable)"
                          value={malStudioQuery}
                          onChange={(e) => setMalStudioQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); searchMalStudios(malStudioQuery); }
                          }}
                        />
                        <Button type="button" variant="outline"
                          onClick={() => searchMalStudios(malStudioQuery)}
                          disabled={isSearchingMalStudios || !malStudioQuery.trim()}>
                          {isSearchingMalStudios ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                        </Button>
                      </div>

                      {/* Search results */}
                      {malStudioResults.length > 0 && (
                        <div className="max-h-32 overflow-y-auto border rounded-md p-2 space-y-1">
                          {malStudioResults.map(studio => (
                            <div key={studio.id} className="flex items-center justify-between gap-2 text-sm">
                              <span className="truncate">{studio.name}</span>
                              <Button type="button" variant="ghost" size="sm"
                                disabled={malProducers.some(p => p.id === studio.id)}
                                onClick={() => {
                                  if (!malProducers.find(p => p.id === studio.id)) {
                                    setMalProducers(prev => [...prev, { id: studio.id, label: studio.name }]);
                                  }
                                  setMalStudioResults([]);
                                  setMalStudioQuery('');
                                }}
                              >
                                {malProducers.some(p => p.id === studio.id) ? 'Added' : 'Add'}
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Selected studios */}
                      {malProducers.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {malProducers.map(producer => (
                            <Badge key={producer.id} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
                              <span className="max-w-[180px] truncate">{producer.label}</span>
                              <button
                                type="button"
                                onClick={() => setMalProducers(prev => prev.filter(p => p.id !== producer.id))}
                                className="rounded-sm p-0.5 hover:bg-background/50"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">No studios selected</p>
                      )}
                    </CardContent>
                  </Card>
                  )}
                  {discoverSource === 'mal' && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Score &amp; Date Range</CardTitle>
                      <CardDescription>Filter by MAL score and air dates.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Score range */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Min Score: {malMinScore}</Label>
                          <input
                            type="range" min={0} max={10} step={0.5}
                            value={malMinScore}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setMalMinScore(val);
                              if (val > malMaxScore) setMalMaxScore(val);
                            }}
                            className="w-full"
                          />
                          <input
                            type="number" min={0} max={10} step={0.5}
                            value={malMinScore}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setMalMinScore(val);
                              if (val > malMaxScore) setMalMaxScore(val);
                            }}
                            className="w-16 h-7 text-xs text-center rounded-md border bg-background"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Max Score: {malMaxScore}</Label>
                          <input
                            type="range" min={0} max={10} step={0.5}
                            value={malMaxScore}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setMalMaxScore(val);
                              if (val < malMinScore) setMalMinScore(val);
                            }}
                            className="w-full"
                          />
                          <input
                            type="number" min={0} max={10} step={0.5}
                            value={malMaxScore}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setMalMaxScore(val);
                              if (val < malMinScore) setMalMinScore(val);
                            }}
                            className="w-16 h-7 text-xs text-center rounded-md border bg-background"
                          />
                        </div>
                      </div>

                      {/* Date range */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="mal-start-date">Aired After</Label>
                          <Input
                            id="mal-start-date" type="date"
                            value={malStartDate}
                            onChange={(e) => setMalStartDate(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="mal-end-date">Aired Before</Label>
                          <Input
                            id="mal-end-date" type="date"
                            value={malEndDate}
                            onChange={(e) => setMalEndDate(e.target.value)}
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  )}
                  {discoverSource === 'mdblist' && (
                  <div className="space-y-4">
                    {/* Sort Direction */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Sort Direction</Label>
                        <Select value={mdblistSortDirection} onValueChange={(v: 'desc' | 'asc') => setMdblistSortDirection(v)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {MDBLIST_SORT_DIRECTION_OPTIONS.map(o => (
                              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                  )}
                  {discoverSource === 'mdblist' && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Score &amp; Year</CardTitle>
                      <CardDescription>Filter by MDBList score and year range.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Score range */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Min Score: {mdblistScoreMin}</Label>
                          <input
                            type="range" min={0} max={100} step={1}
                            value={mdblistScoreMin}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setMdblistScoreMin(val);
                              if (val > mdblistScoreMax) setMdblistScoreMax(val);
                            }}
                            className="w-full"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Max Score: {mdblistScoreMax}</Label>
                          <input
                            type="range" min={0} max={100} step={1}
                            value={mdblistScoreMax}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setMdblistScoreMax(val);
                              if (val < mdblistScoreMin) setMdblistScoreMin(val);
                            }}
                            className="w-full"
                          />
                        </div>
                      </div>
                      {/* Year range */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="mdblist-year-min">Year Min</Label>
                          <Input
                            id="mdblist-year-min" type="number" min={1900} max={2030} placeholder="e.g. 2020"
                            value={mdblistYearMin}
                            onChange={(e) => setMdblistYearMin(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="mdblist-year-max">Year Max</Label>
                          <Input
                            id="mdblist-year-max" type="number" min={1900} max={2030} placeholder="e.g. 2025"
                            value={mdblistYearMax}
                            onChange={(e) => setMdblistYearMax(e.target.value)}
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  )}
                  {discoverSource === 'mdblist' && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Release Date &amp; Runtime</CardTitle>
                      <CardDescription>Filter by release date range and runtime in minutes.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Release date range */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="mdblist-released-from">Released After</Label>
                          <Input
                            id="mdblist-released-from" type="date"
                            value={mdblistReleasedFrom}
                            onChange={(e) => setMdblistReleasedFrom(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="mdblist-released-to">Released Before</Label>
                          <Input
                            id="mdblist-released-to" type="date"
                            value={mdblistReleasedTo}
                            onChange={(e) => setMdblistReleasedTo(e.target.value)}
                          />
                        </div>
                      </div>
                      {/* Runtime range */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="mdblist-runtime-min">Runtime Min (minutes)</Label>
                          <Input
                            id="mdblist-runtime-min" type="number" min={0} placeholder="e.g. 60"
                            value={mdblistRuntimeMin}
                            onChange={(e) => setMdblistRuntimeMin(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="mdblist-runtime-max">Runtime Max (minutes)</Label>
                          <Input
                            id="mdblist-runtime-max" type="number" min={0} placeholder="e.g. 180"
                            value={mdblistRuntimeMax}
                            onChange={(e) => setMdblistRuntimeMax(e.target.value)}
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                  )}
                  {discoverSource === 'mdblist' && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">Language, Country &amp; Genres</CardTitle>
                      <CardDescription>Filter by language/country codes (ISO, comma-separated) and genres.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="mdblist-language">Language</Label>
                          <Input
                            id="mdblist-language" placeholder="e.g. en,fr,de"
                            value={mdblistLanguage}
                            onChange={(e) => setMdblistLanguage(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="mdblist-country">Country</Label>
                          <Input
                            id="mdblist-country" placeholder="e.g. us,gb,ca"
                            value={mdblistCountry}
                            onChange={(e) => setMdblistCountry(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label>Genres</Label>
                          <Select value={mdblistGenreSelection} onValueChange={(v: 'standard' | 'anime' | 'all') => setMdblistGenreSelection(v)}>
                            <SelectTrigger className="w-[140px] h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="standard">Standard</SelectItem>
                              <SelectItem value="anime">Anime</SelectItem>
                              <SelectItem value="all">All</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <Select
                          value=""
                          onValueChange={(value) => {
                            if (value && !mdblistGenres.includes(value)) {
                              setMdblistGenres(prev => [...prev, value]);
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select genre to add" />
                          </SelectTrigger>
                          <SelectContent>
                            {(mdblistGenreSelection === 'standard' ? MDBLIST_STANDARD_GENRES
                              : mdblistGenreSelection === 'anime' ? MDBLIST_ANIME_GENRES
                              : MDBLIST_ALL_GENRES
                            ).filter(g => !mdblistGenres.includes(g.value)).map(genre => (
                              <SelectItem key={genre.value} value={genre.value}>
                                {genre.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {mdblistGenres.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {mdblistGenres.map(genre => (
                              <Badge key={genre} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
                                <span className="max-w-[180px] truncate">{MDBLIST_ALL_GENRES.find(g => g.value === genre)?.label || genre}</span>
                                <button
                                  type="button"
                                  onClick={() => setMdblistGenres(prev => prev.filter(g => g !== genre))}
                                  className="rounded-sm p-0.5 hover:bg-background/50"
                                  aria-label={`Remove ${genre}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No genres selected</p>
                        )}
                      </div>
                      {mdblistGenres.length > 1 && (
                      <div className="space-y-2">
                        <Label>Genre Mode</Label>
                        <Select value={mdblistGenreMode} onValueChange={(v: 'or' | 'and') => setMdblistGenreMode(v)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {JOIN_MODE_OPTIONS.map(option => (
                              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      )}
                    </CardContent>
                  </Card>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="discover-cache-ttl">Cache TTL (seconds)</Label>
                    <Input
                      id="discover-cache-ttl"
                      type="number"
                      min={300}
                      max={604800}
                      value={cacheTTL}
                      onChange={(event) => setCacheTTL(parseInt(event.target.value, 10) || catalogTTL)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Minimum: 300 seconds (5 minutes)
                    </p>
                  </div>
                </div>

                {discoverSource === 'tmdb' ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <Label className="text-sm">Released Only</Label>
                        <p className="text-xs text-muted-foreground">
                          {catalogType === 'movie'
                            ? 'Only include movies released to digital, physical, or TV.'
                            : 'Exclude series that are planned or in production.'}
                        </p>
                      </div>
                      <Switch checked={releasedOnly} onCheckedChange={setReleasedOnly} />
                    </div>
                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <Label className="text-sm">Include Adult</Label>
                        <p className="text-xs text-muted-foreground">Control TMDB adult content filtering for this catalog.</p>
                      </div>
                      <Switch checked={includeAdult} onCheckedChange={setIncludeAdult} />
                    </div>
                  </div>
                ) : discoverSource === 'tvdb' ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Release Status</Label>
                      <Select value={tvdbStatus || NONE_VALUE} onValueChange={(value) => setTvdbStatus(value === NONE_VALUE ? '' : value)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE_VALUE}>Any</SelectItem>
                          {tvdbStatuses.map(status => (
                            <SelectItem key={status.id} value={String(status.id)}>
                              {status.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tvdb-year-filter">Release Year</Label>
                      <Input
                        id="tvdb-year-filter"
                        type="number"
                        min={1800}
                        max={3000}
                        placeholder="Any"
                        value={tvdbYear}
                        onChange={(event) => setTvdbYear(event.target.value)}
                      />
                    </div>
                  </div>
                ) : discoverSource === 'simkl' ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>Genre</Label>
                      <Select value={simklGenre} onValueChange={setSimklGenre}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {simklGenreOptions.map(value => (
                            <SelectItem key={value} value={value}>
                              {formatSimklOptionLabel(value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {simklMediaType !== 'movies' && (
                      <div className="space-y-2">
                        <Label>Type</Label>
                        <Select value={simklType} onValueChange={setSimklType}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {simklTypeOptions.map(value => (
                              <SelectItem key={value} value={value}>
                                {formatSimklOptionLabel(value)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {simklMediaType !== 'anime' && (
                      <div className="space-y-2">
                        <Label>Country</Label>
                        <Select value={simklCountry} onValueChange={setSimklCountry}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {simklCountryOptions.map(value => (
                              <SelectItem key={value} value={value}>
                                {value === 'all' ? 'All Countries' : value.toUpperCase()}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {simklMediaType !== 'movies' && (
                      <div className="space-y-2">
                        <Label>Network</Label>
                        <Select value={simklNetwork} onValueChange={setSimklNetwork}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {simklNetworkOptions.map(value => (
                              <SelectItem key={value} value={value}>
                                {formatSimklOptionLabel(value)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label>Year</Label>
                      <div className="flex gap-2">
                        <Select value={simklYear} onValueChange={setSimklYear}>
                          <SelectTrigger className="flex-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {simklYearOptions.map(value => (
                              <SelectItem key={value} value={value}>
                                {formatSimklOptionLabel(value)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          type="number"
                          min={1950}
                          max={2030}
                          placeholder="Year"
                          className="w-24"
                          value={/^\d+$/.test(simklYear) ? simklYear : ''}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (val === '') {
                              setSimklYear(getSimklDefaultYear(simklMediaType));
                            } else {
                              setSimklYear(val);
                            }
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
            {(discoverSource === 'tmdb' || discoverSource === 'tvdb') && (
              <Card>
              <CardHeader>
                <CardTitle className="text-base">Reference Filters</CardTitle>
                <CardDescription>
                  {discoverSource === 'tmdb'
                    ? 'Select genres, languages, countries, and ratings from TMDB reference data.'
                    : 'Select genres, original language, country of origin, and content ratings from TVDB reference data.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {isLoadingReferences && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {discoverSource === 'tmdb' ? 'Loading TMDB discover reference data...' : 'Loading TVDB discover reference data...'}
                  </div>
                )}

                {!isLoadingReferences && (
                  <>
                    <div className={discoverSource === 'tmdb' ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : 'grid grid-cols-1 gap-4'}>
                      <div className="space-y-2">
                        <Label>Include Genres</Label>
                        <Select value={undefined} onValueChange={(value) => handleAddGenre('include', value)}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select genre" />
                          </SelectTrigger>
                          <SelectContent>
                            {sortedGenres
                              .filter(genre => !includeGenres.some(item => item.id === genre.id))
                              .map(genre => (
                                <SelectItem key={genre.id} value={String(genre.id)}>
                                  {genre.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        {renderSelectedItems(includeGenres, (id) => setIncludeGenres(prev => removeItemById(prev, id)), 'No included genres')}
                      </div>

                      {discoverSource === 'tmdb' && (
                        <div className="space-y-2">
                          <Label>Exclude Genres</Label>
                          <Select value={undefined} onValueChange={(value) => handleAddGenre('exclude', value)}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select genre" />
                            </SelectTrigger>
                            <SelectContent>
                              {sortedGenres
                                .filter(genre => !excludeGenres.some(item => item.id === genre.id))
                                .map(genre => (
                                  <SelectItem key={genre.id} value={String(genre.id)}>
                                    {genre.name}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                          {renderSelectedItems(excludeGenres, (id) => setExcludeGenres(prev => removeItemById(prev, id)), 'No excluded genres')}
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      {discoverSource === 'tmdb' && (
                        <div className="space-y-2">
                          <LabelWithTooltip tooltip="OR returns titles with any selected genre. AND narrows results to titles containing all selected genres.">
                            Genre Match Mode
                          </LabelWithTooltip>
                          <Select value={genreJoinMode} onValueChange={(value: JoinMode) => setGenreJoinMode(value)}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {JOIN_MODE_OPTIONS.map(option => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="space-y-2">
                        <Label>Original Language</Label>
                        <Select value={originalLanguage || NONE_VALUE} onValueChange={(value) => setOriginalLanguage(value === NONE_VALUE ? '' : value)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE_VALUE}>Any</SelectItem>
                            {sortedLanguages.map(languageItem => (
                              <SelectItem key={languageItem.iso_639_1} value={languageItem.iso_639_1}>
                                {(languageItem.english_name || languageItem.name || languageItem.iso_639_1)} ({languageItem.iso_639_1})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>{discoverSource === 'tmdb' ? 'Origin Country' : 'Country of Origin'}</Label>
                        <Select value={originCountry || NONE_VALUE} onValueChange={(value) => setOriginCountry(value === NONE_VALUE ? '' : value)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE_VALUE}>Any</SelectItem>
                            {sortedCountries.map(country => (
                              <SelectItem key={country.iso_3166_1} value={country.iso_3166_1}>
                                {(country.english_name || country.iso_3166_1)} ({country.iso_3166_1.toUpperCase()})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {catalogType === 'movie' && discoverSource === 'tmdb' && (
                        <div className="space-y-2">
                          <Label>Release Region (Movies)</Label>
                          <Select value={releaseRegion || NONE_VALUE} onValueChange={(value) => setReleaseRegion(value === NONE_VALUE ? '' : value)}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                            <SelectItem value={NONE_VALUE}>Any</SelectItem>
                            {sortedCountries.map(country => (
                              <SelectItem key={country.iso_3166_1} value={country.iso_3166_1}>
                                {(country.english_name || country.iso_3166_1)} ({country.iso_3166_1.toUpperCase()})
                              </SelectItem>
                            ))}
                          </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>

                    {(discoverSource === 'tmdb' ? catalogType === 'movie' : true) && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          {discoverSource === 'tmdb' ? (
                            <LabelWithTooltip tooltip="Pick the country first. Certification values depend on this country and can differ between regions.">
                              Certification Country
                            </LabelWithTooltip>
                          ) : (
                            <Label>Rating Country</Label>
                          )}
                          <Select
                            value={certificationCountry || NONE_VALUE}
                            onValueChange={(value) => {
                              const next = value === NONE_VALUE ? '' : value;
                              setCertificationCountry(next);
                              setCertificationValue('');
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE_VALUE}>None</SelectItem>
                              {sortedCountries.map(country => (
                                <SelectItem key={country.iso_3166_1} value={country.iso_3166_1}>
                                  {(country.english_name || country.iso_3166_1)} ({country.iso_3166_1.toUpperCase()})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          {discoverSource === 'tmdb' ? (
                            <LabelWithTooltip tooltip="Applies the age/content rating for the selected certification country (for example PG-13, R, 15).">
                              Certification
                            </LabelWithTooltip>
                          ) : (
                            <Label>Content Rating</Label>
                          )}
                          <Select
                            value={certificationValue || NONE_VALUE}
                            onValueChange={(value) => setCertificationValue(value === NONE_VALUE ? '' : value)}
                            disabled={!certificationCountry}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NONE_VALUE}>None</SelectItem>
                              {certificationOptions.map(certificationItem => (
                                <SelectItem key={certificationItem.certification} value={certificationItem.certification}>
                                  {certificationItem.certification || certificationItem.meaning}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
            )}
            {(discoverSource === 'tmdb' || discoverSource === 'tvdb') && (
              <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {discoverSource === 'tmdb'
                    ? (catalogType === 'movie' ? 'People, Companies, and Keywords' : 'Companies and Keywords')
                    : 'Production Company'}
                </CardTitle>
                <CardDescription>
                  {discoverSource === 'tmdb'
                    ? (catalogType === 'movie'
                        ? 'Search TMDB and add IDs for cast/crew, studios, and keyword filters.'
                        : 'Search TMDB and add IDs for studios and keyword filters.')
                    : 'Search TVDB companies and add a production company filter.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {discoverSource === 'tmdb' && catalogType === 'movie' && (
                  <div className="space-y-2" ref={peopleSearchRef}>
                    <Label>People ({selectedPeople.length})</Label>
                    <div className="space-y-2">
                      <LabelWithTooltip tooltip="OR matches titles with any selected person. AND requires all selected people to be attached as cast or crew.">
                        People Match Mode
                      </LabelWithTooltip>
                      <Select value={peopleJoinMode} onValueChange={(value: JoinMode) => setPeopleJoinMode(value)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {JOIN_MODE_OPTIONS.map(option => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Search person (e.g. Denis Villeneuve)"
                        value={peopleQuery}
                        onChange={(event) => {
                          const value = event.target.value;
                          setPeopleQuery(value);
                          setActiveSearchDropdown(prev => (prev === 'person' ? null : prev));
                          if (!value.trim()) {
                            setPeopleResults([]);
                          }
                        }}
                        onFocus={() => {
                          if (peopleResults.length > 0) {
                            setActiveSearchDropdown('person');
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            searchEntity('person', peopleQuery, setIsSearchingPeople, setPeopleResults);
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            setActiveSearchDropdown(null);
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => searchEntity('person', peopleQuery, setIsSearchingPeople, setPeopleResults)}
                        disabled={isSearchingPeople || !peopleQuery.trim()}
                      >
                        {isSearchingPeople ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                      </Button>
                    </div>
                    {activeSearchDropdown === 'person' && peopleResults.length > 0 && (
                      <div className="max-h-32 overflow-y-auto border rounded-md p-2 space-y-1">
                        <div className="flex items-center justify-between pb-1 border-b">
                          <p className="text-xs text-muted-foreground">{peopleResults.length} results</p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => setActiveSearchDropdown(null)}
                          >
                            Close
                          </Button>
                        </div>
                        {peopleResults.map(person => (
                          <div key={person.id} className="flex items-center justify-between gap-2 text-sm">
                            <span className="truncate">{person.name || person.title || `ID ${person.id}`}</span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setSelectedPeople(prev => addUniqueItem(prev, toSelectionItem(person)));
                                setActiveSearchDropdown(null);
                              }}
                            >
                              Add
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    {renderSelectedItems(selectedPeople, (id) => setSelectedPeople(prev => removeItemById(prev, id)), 'No people selected')}
                  </div>
                )}

                <div className="space-y-2" ref={companySearchRef}>
                  <Label>
                    {discoverSource === 'tmdb'
                      ? `Companies (${withCompanies.length} include / ${withoutCompanies.length} exclude)`
                      : `Production Company (${withCompanies.length} selected)`}
                  </Label>
                  {discoverSource === 'tmdb' && (
                    <div className="space-y-2">
                      <LabelWithTooltip tooltip="OR matches titles from any selected company. AND requires all selected companies to match.">
                        Company Match Mode
                      </LabelWithTooltip>
                      <Select value={companyJoinMode} onValueChange={(value: JoinMode) => setCompanyJoinMode(value)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {JOIN_MODE_OPTIONS.map(option => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Input
                      placeholder={discoverSource === 'tmdb' ? 'Search company (e.g. Pixar)' : 'Search production company (e.g. Pixar)'}
                      value={companyQuery}
                      onChange={(event) => {
                        const value = event.target.value;
                        setCompanyQuery(value);
                        setActiveSearchDropdown(prev => (prev === 'company' ? null : prev));
                        if (!value.trim()) {
                          setCompanyResults([]);
                        }
                      }}
                      onFocus={() => {
                        if (companyResults.length > 0) {
                          setActiveSearchDropdown('company');
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          searchEntity('company', companyQuery, setIsSearchingCompanies, setCompanyResults);
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          setActiveSearchDropdown(null);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => searchEntity('company', companyQuery, setIsSearchingCompanies, setCompanyResults)}
                      disabled={isSearchingCompanies || !companyQuery.trim()}
                    >
                      {isSearchingCompanies ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    </Button>
                  </div>
                  {activeSearchDropdown === 'company' && companyResults.length > 0 && (
                    <div className="max-h-32 overflow-y-auto border rounded-md p-2 space-y-1">
                      <div className="flex items-center justify-between pb-1 border-b">
                        <p className="text-xs text-muted-foreground">{companyResults.length} results</p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => setActiveSearchDropdown(null)}
                        >
                          Close
                        </Button>
                      </div>
                      {companyResults.map(company => (
                        <div key={company.id} className="flex items-center justify-between gap-2 text-sm">
                          <span className="truncate">{company.name || company.title || `ID ${company.id}`}</span>
                          {discoverSource === 'tmdb' ? (
                            <div className="flex gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setWithCompanies(prev => addUniqueItem(prev, toSelectionItem(company)));
                                  setWithoutCompanies(prev => removeItemById(prev, company.id));
                                  setActiveSearchDropdown(null);
                                }}
                              >
                                Include
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setWithoutCompanies(prev => addUniqueItem(prev, toSelectionItem(company)));
                                  setWithCompanies(prev => removeItemById(prev, company.id));
                                  setActiveSearchDropdown(null);
                                }}
                              >
                                Exclude
                              </Button>
                            </div>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setWithCompanies([toSelectionItem(company)]);
                                setWithoutCompanies([]);
                                setActiveSearchDropdown(null);
                              }}
                            >
                              Select
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className={discoverSource === 'tmdb' ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'grid grid-cols-1 gap-3'}>
                    <div className="rounded-md border bg-muted/20 p-3 min-h-[72px]">
                      <p className="text-xs font-medium mb-2">{discoverSource === 'tmdb' ? 'Included companies' : 'Selected production company'}</p>
                      {renderSelectedItems(
                        withCompanies,
                        (id) => setWithCompanies(prev => removeItemById(prev, id)),
                        discoverSource === 'tmdb' ? 'No included companies' : 'No production company selected'
                      )}
                    </div>
                    {discoverSource === 'tmdb' && (
                      <div className="rounded-md border bg-muted/20 p-3 min-h-[72px]">
                        <p className="text-xs font-medium mb-2">Excluded companies</p>
                        {renderSelectedItems(
                          withoutCompanies,
                          (id) => setWithoutCompanies(prev => removeItemById(prev, id)),
                          'No excluded companies'
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {discoverSource === 'tmdb' && (
                <div className="space-y-2" ref={keywordSearchRef}>
                  <Label>Keywords ({withKeywords.length} include / {withoutKeywords.length} exclude)</Label>
                  <div className="space-y-2">
                    <LabelWithTooltip tooltip="OR returns titles with any selected keyword. AND narrows results to titles containing all selected keywords.">
                      Keyword Match Mode
                    </LabelWithTooltip>
                    <Select value={keywordJoinMode} onValueChange={(value: JoinMode) => setKeywordJoinMode(value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {JOIN_MODE_OPTIONS.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Search keyword (e.g. time travel)"
                      value={keywordQuery}
                      onChange={(event) => {
                        const value = event.target.value;
                        setKeywordQuery(value);
                        setActiveSearchDropdown(prev => (prev === 'keyword' ? null : prev));
                        if (!value.trim()) {
                          setKeywordResults([]);
                        }
                      }}
                      onFocus={() => {
                        if (keywordResults.length > 0) {
                          setActiveSearchDropdown('keyword');
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          searchEntity('keyword', keywordQuery, setIsSearchingKeywords, setKeywordResults);
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          setActiveSearchDropdown(null);
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => searchEntity('keyword', keywordQuery, setIsSearchingKeywords, setKeywordResults)}
                      disabled={isSearchingKeywords || !keywordQuery.trim()}
                    >
                      {isSearchingKeywords ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    </Button>
                  </div>
                  {activeSearchDropdown === 'keyword' && keywordResults.length > 0 && (
                    <div className="border rounded-md p-2 space-y-1">
                      <div className="flex items-center justify-between pb-1 border-b">
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-muted-foreground">{keywordResults.length} results</p>
                          {keywordResults.length > 1 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-xs"
                              onClick={() => {
                                const allIds = new Set(keywordResults.map(k => k.id));
                                setSelectedKeywordIds(prev => prev.size === allIds.size ? new Set() : allIds);
                              }}
                            >
                              {selectedKeywordIds.size === keywordResults.length ? 'Deselect All' : 'Select All'}
                            </Button>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => { setActiveSearchDropdown(null); setSelectedKeywordIds(new Set()); }}
                        >
                          Close
                        </Button>
                      </div>
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {keywordResults.map(keyword => {
                          const isAlreadyIncluded = withKeywords.some(k => k.id === keyword.id);
                          const isAlreadyExcluded = withoutKeywords.some(k => k.id === keyword.id);
                          return (
                            <label
                              key={keyword.id}
                              className={`flex items-center gap-2 text-sm p-1 rounded cursor-pointer hover:bg-muted/40 ${
                                isAlreadyIncluded ? 'opacity-50' : isAlreadyExcluded ? 'opacity-50' : ''
                              }`}
                            >
                              <input
                                type="checkbox"
                                className="rounded border-input"
                                checked={selectedKeywordIds.has(keyword.id)}
                                onChange={(e) => {
                                  setSelectedKeywordIds(prev => {
                                    const next = new Set(prev);
                                    if (e.target.checked) next.add(keyword.id);
                                    else next.delete(keyword.id);
                                    return next;
                                  });
                                }}
                              />
                              <span className="truncate flex-1">
                                {keyword.name || keyword.title || `ID ${keyword.id}`}
                                {isAlreadyIncluded && <span className="text-xs text-muted-foreground ml-1">(included)</span>}
                                {isAlreadyExcluded && <span className="text-xs text-muted-foreground ml-1">(excluded)</span>}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      {selectedKeywordIds.size > 0 && (
                        <div className="flex gap-2 pt-1 border-t">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="flex-1 h-7 text-xs"
                            onClick={() => {
                              keywordResults
                                .filter(k => selectedKeywordIds.has(k.id))
                                .forEach(k => {
                                  setWithKeywords(prev => addUniqueItem(prev, toSelectionItem(k)));
                                  setWithoutKeywords(prev => removeItemById(prev, k.id));
                                });
                              setSelectedKeywordIds(new Set());
                            }}
                          >
                            Include {selectedKeywordIds.size} Selected
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="flex-1 h-7 text-xs"
                            onClick={() => {
                              keywordResults
                                .filter(k => selectedKeywordIds.has(k.id))
                                .forEach(k => {
                                  setWithoutKeywords(prev => addUniqueItem(prev, toSelectionItem(k)));
                                  setWithKeywords(prev => removeItemById(prev, k.id));
                                });
                              setSelectedKeywordIds(new Set());
                            }}
                          >
                            Exclude {selectedKeywordIds.size} Selected
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-md border bg-muted/20 p-3 min-h-[72px]">
                      <p className="text-xs font-medium mb-2">Included keywords</p>
                      {renderSelectedItems(
                        withKeywords,
                        (id) => setWithKeywords(prev => removeItemById(prev, id)),
                        'No included keywords'
                      )}
                    </div>
                    <div className="rounded-md border bg-muted/20 p-3 min-h-[72px]">
                      <p className="text-xs font-medium mb-2">Excluded keywords</p>
                      {renderSelectedItems(
                        withoutKeywords,
                        (id) => setWithoutKeywords(prev => removeItemById(prev, id)),
                        'No excluded keywords'
                      )}
                    </div>
                  </div>
                </div>
                )}
              </CardContent>
            </Card>
            )}
            
            {discoverSource === 'anilist' && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Genres &amp; Tags</CardTitle>
                <CardDescription>
                  Include or exclude AniList genres and tags to fine-tune results.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {isLoadingReferences ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading AniList reference data...
                  </div>
                ) : (
                  <>
                    {/* ── Genre Include / Exclude ── */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                      {/* Include Genres */}
                      <div className="space-y-2">
                        <Label>Include Genres</Label>
                        <Select
                          value=""
                          onValueChange={(value) => {
                            if (value && !anilistIncludeGenres.includes(value)) {
                              setAnilistIncludeGenres(prev => [...prev, value]);
                              setAnilistExcludeGenres(prev => prev.filter(g => g !== value));
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select genre to include" />
                          </SelectTrigger>
                          <SelectContent>
                            {ANILIST_GENRES.filter(g => !anilistIncludeGenres.includes(g)).map(genre => (
                              <SelectItem key={genre} value={genre}>
                                {genre}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {anilistIncludeGenres.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {anilistIncludeGenres.map(genre => (
                              <Badge key={genre} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
                                <span className="max-w-[180px] truncate">{genre}</span>
                                <button
                                  type="button"
                                  onClick={() => setAnilistIncludeGenres(prev => prev.filter(g => g !== genre))}
                                  className="rounded-sm p-0.5 hover:bg-background/50"
                                  aria-label={`Remove ${genre}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No included genres</p>
                        )}
                      </div>

                      {/* Exclude Genres */}
                      <div className="space-y-2">
                        <Label>Exclude Genres</Label>
                        <Select
                          value=""
                          onValueChange={(value) => {
                            if (value && !anilistExcludeGenres.includes(value)) {
                              setAnilistExcludeGenres(prev => [...prev, value]);
                              setAnilistIncludeGenres(prev => prev.filter(g => g !== value));
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select genre to exclude" />
                          </SelectTrigger>
                          <SelectContent>
                            {ANILIST_GENRES.filter(g => !anilistExcludeGenres.includes(g)).map(genre => (
                              <SelectItem key={genre} value={genre}>
                                {genre}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {anilistExcludeGenres.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {anilistExcludeGenres.map(genre => (
                              <Badge key={genre} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
                                <span className="max-w-[180px] truncate">{genre}</span>
                                <button
                                  type="button"
                                  onClick={() => setAnilistExcludeGenres(prev => prev.filter(g => g !== genre))}
                                  className="rounded-sm p-0.5 hover:bg-background/50"
                                  aria-label={`Remove ${genre}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No excluded genres</p>
                        )}
                      </div>
                    </div>

                    {/* ── Tag Include / Exclude ── */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                      {/* Include Tags */}
                      <div className="space-y-2">
                        <Label>Include Tags ({anilistIncludeTags.length})</Label>
                        <div className="flex gap-2">
                          <Input
                            placeholder="Search tag (e.g. Isekai, Time Travel)"
                            value={anilistTagSearch}
                            onChange={(event) => setAnilistTagSearch(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                const tag = anilistTagSearch.trim();
                                if (!tag) return;
                                const matched = anilistAvailableTags.find(
                                  t => t.toLowerCase() === tag.toLowerCase()
                                );
                                const tagToAdd = matched || tag;
                                if (!anilistIncludeTags.includes(tagToAdd)) {
                                  setAnilistIncludeTags(prev => [...prev, tagToAdd]);
                                  setAnilistExcludeTags(prev => prev.filter(t => t !== tagToAdd));
                                }
                                setAnilistTagSearch('');
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                event.stopPropagation();
                                setAnilistTagSearch('');
                              }
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            disabled={!anilistTagSearch.trim()}
                            onClick={() => {
                              const tag = anilistTagSearch.trim();
                              if (!tag) return;
                              const matched = anilistAvailableTags.find(
                                t => t.toLowerCase() === tag.toLowerCase()
                              );
                              const tagToAdd = matched || tag;
                              if (!anilistIncludeTags.includes(tagToAdd)) {
                                setAnilistIncludeTags(prev => [...prev, tagToAdd]);
                                setAnilistExcludeTags(prev => prev.filter(t => t !== tagToAdd));
                              }
                              setAnilistTagSearch('');
                            }}
                          >
                            Add
                          </Button>
                        </div>

                        {/* Autocomplete dropdown — only visible while typing */}
                        {anilistTagSearch.trim() && anilistAvailableTags.length > 0 && (
                          <div className="max-h-40 overflow-y-auto border rounded-md p-2 space-y-1">
                            <div className="flex items-center justify-between pb-1 border-b">
                              <p className="text-xs text-muted-foreground">
                                {anilistAvailableTags.filter(t =>
                                  t.toLowerCase().includes(anilistTagSearch.toLowerCase())
                                ).length} matching tags
                              </p>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-xs"
                                onClick={() => setAnilistTagSearch('')}
                              >
                                Close
                              </Button>
                            </div>
                            {anilistAvailableTags
                              .filter(t => t.toLowerCase().includes(anilistTagSearch.toLowerCase()))
                              .slice(0, 20)
                              .map(tag => (
                                <div
                                  key={tag}
                                  className="flex items-center justify-between gap-2 text-sm"
                                >
                                  <span className="truncate">{tag}</span>
                                  <div className="flex gap-1 flex-shrink-0">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => {
                                        if (!anilistIncludeTags.includes(tag)) {
                                          setAnilistIncludeTags(prev => [...prev, tag]);
                                        }
                                        setAnilistExcludeTags(prev => prev.filter(t => t !== tag));
                                        setAnilistTagSearch('');
                                      }}
                                    >
                                      Include
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => {
                                        if (!anilistExcludeTags.includes(tag)) {
                                          setAnilistExcludeTags(prev => [...prev, tag]);
                                        }
                                        setAnilistIncludeTags(prev => prev.filter(t => t !== tag));
                                        setAnilistTagSearch('');
                                      }}
                                    >
                                      Exclude
                                    </Button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}

                        {/* Selected include tags */}
                        {anilistIncludeTags.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {anilistIncludeTags.map(tag => (
                              <Badge key={tag} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
                                <span className="max-w-[180px] truncate">{tag}</span>
                                <button
                                  type="button"
                                  onClick={() => setAnilistIncludeTags(prev => prev.filter(t => t !== tag))}
                                  className="rounded-sm p-0.5 hover:bg-background/50"
                                  aria-label={`Remove ${tag}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No included tags</p>
                        )}
                      </div>

                      {/* Exclude Tags */}
                      <div className="space-y-2">
                        <Label>Exclude Tags ({anilistExcludeTags.length})</Label>
                        <p className="text-xs text-muted-foreground mb-1">
                          Use the tag search on the left and click "Exclude" to add tags here.
                        </p>
                        {anilistExcludeTags.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {anilistExcludeTags.map(tag => (
                              <Badge key={tag} variant="secondary" className="gap-1 pl-2 pr-1 py-1">
                                <span className="max-w-[180px] truncate">{tag}</span>
                                <button
                                  type="button"
                                  onClick={() => setAnilistExcludeTags(prev => prev.filter(t => t !== tag))}
                                  className="rounded-sm p-0.5 hover:bg-background/50"
                                  aria-label={`Remove ${tag}`}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">No excluded tags</p>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
            )}

            {discoverSource === 'anilist' && (
              <Card>
              <CardHeader>
                <CardTitle className="text-base">Studio</CardTitle>
                <CardDescription>Search and filter by animation studio.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    placeholder="Search studio (e.g. MAPPA, Bones, ufotable)"
                    value={anilistStudioQuery}
                    onChange={(e) => setAnilistStudioQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); searchAnilistStudios(anilistStudioQuery); }
                    }}
                  />
                  <Button type="button" variant="outline"
                    onClick={() => searchAnilistStudios(anilistStudioQuery)}
                    disabled={isSearchingStudios || !anilistStudioQuery.trim()}>
                    {isSearchingStudios ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  </Button>
                </div>
                {anilistStudioResults.length > 0 && (
                  <div className="max-h-32 overflow-y-auto border rounded-md p-2 space-y-1">
                    {anilistStudioResults.map(studio => (
                      <div key={studio.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">{studio.name}</span>
                        <Button type="button" variant="ghost" size="sm" onClick={() => {
                          setAnilistSelectedStudios(prev => addUniqueItem(prev, { id: studio.id, label: studio.name }));
                          setAnilistStudioResults([]);
                          setAnilistStudioQuery('');
                        }}>Add</Button>
                      </div>
                    ))}
                  </div>
                )}
                {renderSelectedItems(
                  anilistSelectedStudios,
                  (id) => setAnilistSelectedStudios(prev => removeItemById(prev, id)),
                  'No studios selected'
                )}
              </CardContent>
            </Card>
            )}

            {discoverSource === 'anilist' && (
              <Card className="border-cyan-500/20 bg-cyan-500/5">
                <CardHeader>
                  <CardTitle className="text-base text-cyan-600 dark:text-cyan-400 flex items-center gap-2">
                    <Wand2 className="h-4 w-4" />
                    AniList Advanced Filters
                  </CardTitle>
                  <CardDescription>
                    Apply granular thresholds for scores, length, and release windows.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Row 1: Score & Popularity */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-3 rounded-md border bg-background p-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Average Score (%)</Label>
                        <span className="font-mono text-xs font-bold text-cyan-600">{anilistScoreRange[0]}% - {anilistScoreRange[1]}%</span>
                      </div>
                      <div className="flex flex-col gap-4">
                        <div className="space-y-1">
                          <p className="text-[10px] text-muted-foreground">Minimum Score</p>
                          <input
                            type="range" min={0} max={100} step={1}
                            value={anilistScoreRange[0]}
                            onChange={(e) => setAnilistScoreRange([Number(e.target.value), anilistScoreRange[1]])}
                            className="w-full accent-cyan-500"
                          />
                          <input
                            type="number" min={0} max={100} step={1}
                            value={anilistScoreRange[0]}
                            onChange={(e) => setAnilistScoreRange([Number(e.target.value), anilistScoreRange[1]])}
                            className="w-16 h-7 text-xs text-center rounded-md border bg-background"
                          />
                        </div>
                        <div className="space-y-1">
                          <p className="text-[10px] text-muted-foreground">Maximum Score</p>
                          <input
                            type="range" min={0} max={100} step={1}
                            value={anilistScoreRange[1]}
                            onChange={(e) => setAnilistScoreRange([anilistScoreRange[0], Number(e.target.value)])}
                            className="w-full accent-cyan-500"
                          />
                          <input
                            type="number" min={0} max={100} step={1}
                            value={anilistScoreRange[1]}
                            onChange={(e) => setAnilistScoreRange([anilistScoreRange[0], Number(e.target.value)])}
                            className="w-16 h-7 text-xs text-center rounded-md border bg-background"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3 rounded-md border bg-background p-3 flex flex-col justify-center">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Min Popularity</Label>
                        <span className="font-mono text-xs font-bold">{anilistPopularityMin.toLocaleString()}</span>
                      </div>
                      <input
                        type="range" min={0} max={50000} step={500}
                        value={anilistPopularityMin}
                        onChange={(e) => setAnilistPopularityMin(Number(e.target.value))}
                        className="w-full accent-primary"
                      />
                      <p className="text-[10px] text-muted-foreground">Minimum number of users who have this in their list.</p>
                    </div>
                  </div>

                  {/* Row 2: Episodes & Duration */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-3 rounded-md border bg-background p-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Episode Count</Label>
                        <span className="font-mono text-xs font-bold">{anilistEpisodesRange[0]} - {anilistEpisodesRange[1] === 200 ? '200+' : anilistEpisodesRange[1]}</span>
                      </div>
                      <div className="flex flex-col gap-4">
                        <input
                          type="range" min={0} max={200} step={1}
                          value={anilistEpisodesRange[0]}
                          onChange={(e) => setAnilistEpisodesRange([Number(e.target.value), anilistEpisodesRange[1]])}
                          className="w-full accent-primary"
                        />
                        <input
                          type="range" min={0} max={200} step={1}
                          value={anilistEpisodesRange[1]}
                          onChange={(e) => setAnilistEpisodesRange([anilistEpisodesRange[0], Number(e.target.value)])}
                          className="w-full accent-primary"
                        />
                      </div>
                    </div>

                    <div className="space-y-3 rounded-md border bg-background p-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Duration (Mins)</Label>
                        <span className="font-mono text-xs font-bold">{anilistDurationRange[0]} - {anilistDurationRange[1]}m</span>
                      </div>
                      <div className="flex flex-col gap-4">
                        <input
                          type="range" min={0} max={180} step={5}
                          value={anilistDurationRange[0]}
                          onChange={(e) => setAnilistDurationRange([Number(e.target.value), anilistDurationRange[1]])}
                          className="w-full accent-primary"
                        />
                        <input
                          type="range" min={0} max={180} step={5}
                          value={anilistDurationRange[1]}
                          onChange={(e) => setAnilistDurationRange([anilistDurationRange[0], Number(e.target.value)])}
                          className="w-full accent-primary"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Row 3: Start Date Range */}
                  <div className="space-y-3 rounded-md border bg-background p-4">
                    <Label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Release Date Window</Label>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <p className="text-[10px] text-muted-foreground ml-1">From</p>
                        <Input 
                          type="date" 
                          value={anilistStartDateFrom} 
                          onChange={(e) => setAnilistStartDateFrom(e.target.value)}
                          className="h-9"
                        />
                      </div>
                      <div className="space-y-1">
                        <p className="text-[10px] text-muted-foreground ml-1">To</p>
                        <Input 
                          type="date" 
                          value={anilistStartDateTo} 
                          onChange={(e) => setAnilistStartDateTo(e.target.value)}
                          className="h-9"
                        />
                      </div>
                    </div>
                  </div>
                  
                  {/* Row 4: Toggles */}
                  <div className="flex items-center justify-between p-3 rounded-md border bg-background">
                    <div className="space-y-0.5">
                      <Label>Include Adult Content</Label>
                      <p className="text-[10px] text-muted-foreground">Toggle Hentai/18+ results in this catalog.</p>
                    </div>
                    <Switch 
                      checked={anilistIsAdult} 
                      onCheckedChange={setAnilistIsAdult}
                      className="data-[state=checked]:bg-cyan-500"
                    />
                  </div>
                </CardContent>
              </Card>
            )}

            {discoverSource === 'tmdb' && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Streaming and Region</CardTitle>
                <CardDescription>
                  Filter by watch region and watch providers from TMDB.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <Label>Watch Region</Label>
                    <Select value={watchRegion || NONE_VALUE} onValueChange={(value) => {
                      const regionValue = value === NONE_VALUE ? '' : value;
                      setWatchRegion(regionValue);
                      setWatchProviders([]);
                    }}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE_VALUE}>Any</SelectItem>
                        {sortedRegions.map(region => (
                          <SelectItem key={region.iso_3166_1} value={region.iso_3166_1}>
                            {(region.english_name || region.iso_3166_1)} ({region.iso_3166_1})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <LabelWithTooltip tooltip="OR matches titles available on any selected provider. AND requires availability across all selected providers.">
                      Provider Match Mode
                    </LabelWithTooltip>
                    <Select value={providerJoinMode} onValueChange={(value: JoinMode) => setProviderJoinMode(value)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {JOIN_MODE_OPTIONS.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tmdb-provider-filter">Provider Search</Label>
                    <Input
                      id="tmdb-provider-filter"
                      placeholder="Filter providers..."
                      value={providerFilter}
                      onChange={(event) => setProviderFilter(event.target.value)}
                    />
                  </div>
                </div>

                {isLoadingProviders && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading providers for selected region...
                  </div>
                )}

                {!isLoadingProviders && watchRegion && filteredProviders.length > 0 && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-52 overflow-y-auto border rounded-md p-2">
                    {filteredProviders.map(provider => {
                      const selected = watchProviders.some(item => item.id === provider.provider_id);
                      return (
                        <Button
                          key={provider.provider_id}
                          type="button"
                          variant={selected ? 'default' : 'outline'}
                          size="sm"
                          className="justify-start"
                          onClick={() => handleToggleProvider(provider)}
                        >
                          <span className="truncate">{provider.provider_name}</span>
                        </Button>
                      );
                    })}
                  </div>
                )}

                {watchRegion && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Selected providers</p>
                    {renderSelectedItems(watchProviders, (id) => setWatchProviders(prev => removeItemById(prev, id)), 'No providers selected')}
                  </div>
                )}
              </CardContent>
            </Card>
            )}

            {discoverSource === 'tmdb' && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Numeric and Date Ranges</CardTitle>
                <CardDescription>
                  Apply quality thresholds and date windows.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-3 rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <Label>Vote Average</Label>
                      <span className="text-xs text-muted-foreground">
                        {voteAverageRange[0].toFixed(1)} - {voteAverageRange[1].toFixed(1)}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Minimum</p>
                        <input
                          type="range"
                          min={0}
                          max={10}
                          step={0.1}
                          value={voteAverageRange[0]}
                          onChange={(event) => handleVoteAverageMinSliderChange(Number(event.target.value))}
                          className="w-full accent-primary"
                        />
                        <input
                          type="number"
                          min={0}
                          max={10}
                          step={0.1}
                          value={voteAverageRange[0]}
                          onChange={(event) => handleVoteAverageMinSliderChange(Number(event.target.value))}
                          className="w-16 h-7 text-xs text-center rounded-md border bg-background"
                        />
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Maximum</p>
                        <input
                          type="range"
                          min={0}
                          max={10}
                          step={0.1}
                          value={voteAverageRange[1]}
                          onChange={(event) => handleVoteAverageMaxSliderChange(Number(event.target.value))}
                          className="w-full accent-primary"
                        />
                        <input
                          type="number"
                          min={0}
                          max={10}
                          step={0.1}
                          value={voteAverageRange[1]}
                          onChange={(event) => handleVoteAverageMaxSliderChange(Number(event.target.value))}
                          className="w-16 h-7 text-xs text-center rounded-md border bg-background"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3 rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <Label>Vote Count Min</Label>
                      <span className="text-xs text-muted-foreground">
                        {voteCountMin === 0 ? 'Any' : voteCountMin.toLocaleString()}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={MAX_VOTE_COUNT}
                      step={1}
                      value={voteCountMin}
                      onChange={(event) => setVoteCountMin(Number(event.target.value))}
                      className="w-full accent-primary"
                    /><input
                      type="number"
                      min={0}
                      max={MAX_VOTE_COUNT}
                      step={1}
                      value={voteCountMin}
                      onChange={(event) => setVoteCountMin(Number(event.target.value))}
                      className="w-16 h-7 text-xs text-center rounded-md border bg-background"
                    />
                    <p className="text-xs text-muted-foreground">
                      Increase to exclude low-vote titles.
                    </p>
                  </div>

                  <div className="space-y-3 rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <Label>Runtime (Minutes)</Label>
                      <span className="text-xs text-muted-foreground">
                        {runtimeRange[0]} - {runtimeRange[1]}
                      </span>
                    </div>
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Minimum</p>
                        <input
                          type="range"
                          min={0}
                          max={MAX_RUNTIME_MINUTES}
                          step={5}
                          value={runtimeRange[0]}
                          onChange={(event) => handleRuntimeMinSliderChange(Number(event.target.value))}
                          className="w-full accent-primary"
                        />
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Maximum</p>
                        <input
                          type="range"
                          min={0}
                          max={MAX_RUNTIME_MINUTES}
                          step={5}
                          value={runtimeRange[1]}
                          onChange={(event) => handleRuntimeMaxSliderChange(Number(event.target.value))}
                          className="w-full accent-primary"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {catalogType === 'movie' ? (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label>Primary Release Presets</Label>
                      <div className="flex flex-wrap gap-2">
                        {DATE_PRESET_OPTIONS.map(option => (
                          <Button
                            key={option.value}
                            type="button"
                            size="sm"
                            variant={movieDatePreset === option.value ? 'default' : 'outline'}
                            onClick={() => applyDatePreset('movie', option.value)}
                          >
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="primary-release-from">Primary Release From</Label>
                        <Input
                          id="primary-release-from"
                          type="date"
                          value={primaryReleaseFrom}
                          onChange={(event) => {
                            setPrimaryReleaseFrom(event.target.value);
                            setMovieDatePreset('custom');
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="primary-release-to">Primary Release To</Label>
                        <Input
                          id="primary-release-to"
                          type="date"
                          value={primaryReleaseTo}
                          onChange={(event) => {
                            setPrimaryReleaseTo(event.target.value);
                            setMovieDatePreset('custom');
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label>First Air Date Presets</Label>
                      <div className="flex flex-wrap gap-2">
                        {DATE_PRESET_OPTIONS.map(option => (
                          <Button
                            key={option.value}
                            type="button"
                            size="sm"
                            variant={seriesDatePreset === option.value ? 'default' : 'outline'}
                            onClick={() => applyDatePreset('series', option.value)}
                          >
                            {option.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="first-air-from">First Air Date From</Label>
                        <Input
                          id="first-air-from"
                          type="date"
                          value={firstAirFrom}
                          onChange={(event) => {
                            setFirstAirFrom(event.target.value);
                            setSeriesDatePreset('custom');
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="first-air-to">First Air Date To</Label>
                        <Input
                          id="first-air-to"
                          type="date"
                          value={firstAirTo}
                          onChange={(event) => {
                            setFirstAirTo(event.target.value);
                            setSeriesDatePreset('custom');
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="air-date-from">Episode Air Date From</Label>
                        <Input id="air-date-from" type="date" value={airDateFrom} onChange={(event) => setAirDateFrom(event.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="air-date-to">Episode Air Date To</Label>
                        <Input id="air-date-to" type="date" value={airDateTo} onChange={(event) => setAirDateTo(event.target.value)} />
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Preview</CardTitle>
                <CardDescription>
                  {activeFilterCount} active filter{activeFilterCount === 1 ? '' : 's'} plus sorting
                  {discoverSource === 'tmdb' ? ' and adult-content rules.' : '.'}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground break-all">
                    {JSON.stringify(discoverParamsPreview)}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          {showPreview && (
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">
                    Preview {previewTotalResults > 0 && `(${previewTotalResults.toLocaleString()} total results)`}
                  </CardTitle>
                  <Button variant="ghost" size="icon" onClick={() => setShowPreview(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {isPreviewLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : previewResults.length > 0 ? (
                  <div className="grid grid-cols-4 md:grid-cols-6 gap-3">
                    {previewResults.map((item) => (
                      <div key={item.id} className="space-y-1">
                        {item.poster_path ? (
                          <img
                            src={
                              discoverSource === 'tmdb' && item.poster_path
                                ? `https://image.tmdb.org/t/p/w185${item.poster_path}`
                                : discoverSource === 'tvdb' && item.poster_path && !item.poster_path.startsWith('http')
                                  ? `https://artworks.thetvdb.com${item.poster_path}`
                                  : item.poster_path || ''
                            }
                            alt={item.title}
                            className="w-full aspect-[2/3] object-cover rounded-md bg-muted"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full aspect-[2/3] rounded-md bg-muted flex items-center justify-center">
                            <span className="text-xs text-muted-foreground">No poster</span>
                          </div>
                        )}
                        <p className="text-xs truncate" title={item.title}>{item.title}</p>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          {item.vote_average && <span>⭐ {item.vote_average.toFixed(1)}</span>}
                          {item.score && <span>⭐ {item.score}%</span>}
                          {item.release_date && <span>{item.release_date.substring(0, 4)}</span>}
                          {item.year && !item.release_date && <span>{item.year}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No results found with current filters. Try broadening your criteria.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button variant="outline" onClick={handlePreview} disabled={isPreviewLoading}>
            {isPreviewLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Preview
          </Button>
          <Button
            onClick={handleCreateCatalog}
            disabled={!catalogName.trim() || isSaving}
          >
            {isSaving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {editingCatalog ? 'Saving...' : 'Creating...'}
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4 mr-2" />
                {editingCatalog ? 'Save Changes' : 'Build Catalog'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>

      <AlertDialog open={showMdblistPreviewConfirm} onOpenChange={setShowMdblistPreviewConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>MDBList Preview</AlertDialogTitle>
            <AlertDialogDescription>
              This preview uses a catalog query that counts against your MDBList plan quota. The results will be cached and reused when browsing in Stremio, so it won't count again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={mdblistPreviewRemember}
              onChange={(e) => setMdblistPreviewRemember(e.target.checked)}
              className="rounded"
            />
            Don't ask again
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setMdblistPreviewRemember(false);
            }}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (mdblistPreviewRemember) {
                localStorage.setItem('mdblist-preview-confirmed', 'true');
              }
              setShowMdblistPreviewConfirm(false);
              setMdblistPreviewRemember(false);
              executeMdblistPreview();
            }}>Proceed</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
