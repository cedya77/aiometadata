import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useConfig } from '@/contexts/ConfigContext';
import { AppConfig, CatalogConfig } from '@/contexts/config';
import { allCatalogDefinitions } from '@/data/catalogs';
import { Film, Tv, Sparkles, Users, ShieldCheck, PlayCircle, CheckCircle2, Loader2, CircleHelp } from 'lucide-react';
import { toast } from 'sonner';
import { MDBListAPIKeyModal } from '@/components/MDBListAPIKeyModal';
import { cn } from '@/lib/utils';
import { exportConfigFile } from '@/lib/exportConfigFile';
import { apiCache } from '@/utils/apiCache';

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
      'Movies via TMDB, series via TVDB',
      'Disables anime-type catalogs and MAL catalogs',
      'Turns off anime search engines',
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
    description: 'Best of both worlds - traditional content plus anime with Kitsu metadata. Anime posters use Meta, while backgrounds and logos use IMDb.',
    icon: <Sparkles className="h-6 w-6" />,
    badge: 'Hybrid',
    badgeColor: 'bg-purple-500',
    tagline: 'Balanced catalog with anime powered by Kitsu.',
    highlights: [
      'Movies via TMDB, series via TVDB, anime via Kitsu',
      'Anime search engine using Kitsu',
      'Anime art: Meta posters + IMDb backdrops/logos',
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
    description: 'Hybrid setup that uses TVDB for anime metadata, Kitsu for compatibility IDs/search, and MAL/IMDb artwork for anime.',
    icon: <Tv className="h-6 w-6" />,
    badge: 'Hybrid TVDB',
    badgeColor: 'bg-green-500',
    tagline: 'Great if you prefer TVDB for anime metadata.',
    highlights: [
      'Movies via TMDB, series via TVDB, anime via TVDB',
      'Uses Kitsu IDs for anime',
      'Anime art: MAL posters + IMDb backdrops/logos',
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
    description: 'Anime-first setup that forces anime handling for detected IMDb titles and uses IMDb IDs for MAL catalog/search matching.',
    icon: <Users className="h-6 w-6" />,
    badge: 'Anime Focus',
    badgeColor: 'bg-pink-500',
    tagline: 'Anime-first preset with IMDb anime matching enabled.',
    highlights: [
      'Enables grouped MAL catalogs',
      'Uses IMDb IDs for better compatibility',
      'Anime art: TVDB posters + IMDb backdrops/logos',
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

type WizardStep = 1 | 2 | 3 | 4 | 5;
type StepOneMode = 'cards' | 'guided';
type RequiredKeyId = 'tmdb' | 'tvdb';
type RequiredKeyMode = 'custom' | 'builtin';
type RequiredKeyTestStatus = 'idle' | 'testing' | 'valid' | 'invalid' | 'timeout' | 'error';
type CatalogMediaType = 'movie' | 'series';
type GuidedBinaryAnswer = 'yes' | 'no';
type GuidedAnimeSourceAnswer = 'kitsu' | 'tvdb' | 'imdb';

interface GuidedPresetAnswers {
  animeFan?: GuidedBinaryAnswer;
  groupedSeasons?: GuidedBinaryAnswer;
  animeSource?: GuidedAnimeSourceAnswer;
}

interface CuratorProfile {
  username: string;
  name: string;
  description: string;
}

interface MDBListCollection {
  id: number | string;
  name: string;
  mediatype?: string;
  items?: number;
  user_name?: string;
  user?: string;
  curatorName?: string;
}

interface CuratorSelectableList extends MDBListCollection {
  curatorName: string;
  curatorUsername: string;
  selectionKey: string;
}

interface RequiredKeyConfig {
  label: string;
  placeholder: string;
  helper: string;
  linkHref?: string;
}

interface WizardStepConfig {
  id: WizardStep;
  label: string;
  hint: string;
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

interface SelectionItem {
  id: number;
  label: string;
}

interface SelectedStreamingService {
  key: string;
  label: string;
  providerIds: number[];
  watchProviders: SelectionItem[];
  region: string;
  source: 'popular' | 'custom';
}

interface PopularStreamingService {
  key: string;
  label: string;
  providerIds: number[];
}

const NONE_VALUE = '__none__';

const popularStreamingServices: PopularStreamingService[] = [
  { key: 'netflix', label: 'Netflix', providerIds: [8] },
  { key: 'hbo-max', label: 'HBO Max', providerIds: [1899] },
  { key: 'disney-plus', label: 'Disney+', providerIds: [337] },
  { key: 'prime-video', label: 'Prime Video', providerIds: [9] },
  { key: 'apple-tv', label: 'Apple TV', providerIds: [350] },
  { key: 'paramount', label: 'Paramount', providerIds: [2616, 2303] },
  { key: 'peacock', label: 'Peacock', providerIds: [386, 387] },
  { key: 'hulu', label: 'Hulu', providerIds: [15] },
  { key: 'netflix-kids', label: 'Netflix Kids', providerIds: [175] },
  { key: 'crunchyroll', label: 'Crunchyroll', providerIds: [283] },
  { key: 'mubi', label: 'Mubi', providerIds: [11] },
  { key: 'criterion', label: 'Criterion', providerIds: [258] },
  { key: 'discovery-plus', label: 'Discovery+', providerIds: [520] },
  { key: 'starz', label: 'Starz', providerIds: [43] },
  { key: 'globoplay', label: 'Globoplay', providerIds: [307] },
  { key: 'canal-plus', label: 'Canal+', providerIds: [381] },
  { key: 'jiohotstar', label: 'JioHotstar', providerIds: [2336] },
  { key: 'claro-video', label: 'Claro Video', providerIds: [167] },
  { key: 'zee5', label: 'Zee5', providerIds: [232] },
  { key: 'sky-go', label: 'Sky Go', providerIds: [29] },
  { key: 'rakuten-viki', label: 'Rakuten Viki', providerIds: [344] },
  { key: 'magellantv', label: 'MagellanTV', providerIds: [551] },
];

const popularStreamingServiceIcons: Record<string, string | null> = {
  netflix: '/netflix.webp',
  'hbo-max': '/max.webp',
  'disney-plus': '/disney.webp',
  'prime-video': '/prime.webp',
  'apple-tv': '/apple.webp',
  paramount: '/paramount.webp',
  peacock: '/peacock.webp',
  hulu: '/hulu.webp',
  'netflix-kids': '/netflixkids.webp',
  crunchyroll: '/crunchyroll.webp',
  mubi: '/mubi.jpg',
  criterion: '/criterionchannel.jpg',
  'discovery-plus': '/discovery-plus.webp',
  starz: '/starz.jpg',
  globoplay: '/globo.webp',
  'canal-plus': '/canal-plus.webp',
  jiohotstar: '/hotstar.webp',
  'claro-video': '/claro.webp',
  zee5: '/zee5.webp',
  'sky-go': '/skygo.jpg',
  'rakuten-viki': '/rakuten_viki.webp',
  magellantv: '/magellan.webp',
};

const predefinedStreamingProviderIds = new Set(
  popularStreamingServices.flatMap((service) => service.providerIds)
);
const TMDB_DYNAMIC_DATE_TOKEN_PREFIX = '__tmdb_date__';
const SETTINGS_LAYOUT_NAVIGATE_EVENT = 'settings-layout:navigate';
const LABEL_OVERRIDE_TOOLTIP_TEXT = "Clients like stremio show catalogs as such: 'Netflix - Series', this lets you override the catalog type to your liking, for example 'Netflix - Shows'";
const STREAMING_TIME_RANGE_OPTIONS = [
  { value: 'last_month', label: 'Last Month' },
  { value: 'last_year', label: 'Last Year' },
] as const;
type StreamingTimeRangePreset = (typeof STREAMING_TIME_RANGE_OPTIONS)[number]['value'];

function buildTmdbStreamingDateToken(preset: StreamingTimeRangePreset, bound: 'from' | 'to'): string {
  return `${TMDB_DYNAMIC_DATE_TOKEN_PREFIX}:${preset}:${bound}`;
}

function formatLocalDateForInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getStreamingDateRange(preset: StreamingTimeRangePreset): { from: string; to: string } {
  const now = new Date();
  const to = formatLocalDateForInput(now);
  const fromDate = new Date(now);
  if (preset === 'last_month') {
    fromDate.setDate(fromDate.getDate() - 30);
  } else {
    fromDate.setFullYear(fromDate.getFullYear() - 1);
  }
  return { from: formatLocalDateForInput(fromDate), to };
}

function buildTmdbDiscoverWebUrl(
  mediaType: 'movie' | 'tv',
  params: Record<string, string | number | boolean | null | undefined>
): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.append(key, String(value));
  });
  return `https://www.themoviedb.org/discover/${mediaType}?${search.toString()}`;
}

const requiredKeyConfig: Record<RequiredKeyId, RequiredKeyConfig> = {
  tmdb: {
    label: 'TMDB API Key',
    placeholder: 'Enter TMDB API key',
    helper: 'Required when this preset uses TMDB metadata or search.',
    linkHref: 'https://www.themoviedb.org/settings/api',
  },
  tvdb: {
    label: 'TVDB API Key',
    placeholder: 'Enter TVDB API key',
    helper: 'Required when this preset uses TVDB metadata or search.',
    linkHref: 'https://thetvdb.com/api-information',
  },
};

const optionalMDBListKeyConfig = {
  id: 'mdblist' as const,
  label: 'MDBList API Key',
  placeholder: 'Enter MDBList API key',
  helper: 'Optional. Used for Step 5 curator imports and other MDBList-based features.',
  linkHref: 'https://mdblist.com/preferences/#api_key_uid',
};

const wizardStepConfig: WizardStepConfig[] = [
  { id: 1, label: 'Preset', hint: 'Pick the preset that matches your library.' },
  { id: 2, label: 'Safety + Labels', hint: 'Adjust safe viewing and catalog wording.' },
  { id: 3, label: 'Keys', hint: 'Add required API keys for your selected preset.' },
  { id: 4, label: 'Streaming Services', hint: 'Quickly add TMDB discover catalogs by service and region.' },
  { id: 5, label: 'Curators', hint: 'Optionally import trusted curated collections.' },
];

const trustedCurators: CuratorProfile[] = [
  { username: 'danaramapyjama', name: 'Dan Pyjama', description: 'Curated lists of films by a pyjama wearer for pyjama wearers' },
  { username: 'tvgeniekodi', name: 'Mr. Professor', description: 'Curated TV and movie lists' },
  { username: 'snoak', name: 'Snoak', description: 'Quality content collections' },
  { username: 'garycrawfordgc', name: 'Gary Crawford', description: 'Expert curated lists' }
];


export function PresetManager() {
  const { config, setConfig, catalogTTL, auth, addonVersion, hasBuiltInTmdb, hasBuiltInTvdb } = useConfig();
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [stepOneMode, setStepOneMode] = useState<StepOneMode>('cards');
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [expandedPresetId, setExpandedPresetId] = useState<string | null>(null);
  const [guidedAnswers, setGuidedAnswers] = useState<GuidedPresetAnswers>({});
  const [guidedQuestionIndex, setGuidedQuestionIndex] = useState(0);
  const [showEasyGuideSuccess, setShowEasyGuideSuccess] = useState(false);
  const [guidedSuccessTitle, setGuidedSuccessTitle] = useState('That was easy!');
  const [guidedSuccessPresetName, setGuidedSuccessPresetName] = useState('');
  const [includeAdult, setIncludeAdult] = useState(config.includeAdult || false);
  const [loadedCuratorLists, setLoadedCuratorLists] = useState<CuratorSelectableList[]>([]);
  const [selectedCuratorListKeys, setSelectedCuratorListKeys] = useState<Set<string>>(new Set());
  const [isLoadingCuratorLists, setIsLoadingCuratorLists] = useState(false);
  const [loadingCuratorUsername, setLoadingCuratorUsername] = useState<string | null>(null);
  const [userListSort, setUserListSort] = useState<'ranked' | 'name' | 'created'>('ranked');
  const [overrideMovieType, setOverrideMovieType] = useState(!!config.displayTypeOverrides?.movie);
  const [movieDisplayType, setMovieDisplayType] = useState(config.displayTypeOverrides?.movie || '');
  const [overrideSeriesType, setOverrideSeriesType] = useState(!!config.displayTypeOverrides?.series);
  const [seriesDisplayType, setSeriesDisplayType] = useState(config.displayTypeOverrides?.series || '');
  const [lastAppliedPresetId, setLastAppliedPresetId] = useState<string | null>(null);
  const [isApplyingWizard, setIsApplyingWizard] = useState(false);
  const [showBackupDialog, setShowBackupDialog] = useState(false);
  const [showApplySuccessDialog, setShowApplySuccessDialog] = useState(false);
  const [applySuccessSummary, setApplySuccessSummary] = useState('');
  const [isExportingBackup, setIsExportingBackup] = useState(false);
  const [requiredKeyInputs, setRequiredKeyInputs] = useState<Record<RequiredKeyId, string>>({
    tmdb: config.apiKeys.tmdb || '',
    tvdb: config.apiKeys.tvdb || '',
  });
  const [requiredKeyModes, setRequiredKeyModes] = useState<Record<RequiredKeyId, RequiredKeyMode>>({
    tmdb: hasBuiltInTmdb && !(config.apiKeys.tmdb || '').trim() ? 'builtin' : 'custom',
    tvdb: hasBuiltInTvdb && !(config.apiKeys.tvdb || '').trim() ? 'builtin' : 'custom',
  });
  const [requiredKeyTestStatus, setRequiredKeyTestStatus] = useState<Record<RequiredKeyId, RequiredKeyTestStatus>>({
    tmdb: 'idle',
    tvdb: 'idle',
  });
  const [requiredKeyTestMessage, setRequiredKeyTestMessage] = useState<Record<RequiredKeyId, string>>({
    tmdb: '',
    tvdb: '',
  });
  const [optionalMdblistKeyInput, setOptionalMdblistKeyInput] = useState(config.apiKeys.mdblist || '');
  const [optionalMdblistKeyTestStatus, setOptionalMdblistKeyTestStatus] = useState<RequiredKeyTestStatus>('idle');
  const [optionalMdblistKeyTestMessage, setOptionalMdblistKeyTestMessage] = useState('');
  const [streamingWatchRegion, setStreamingWatchRegion] = useState<string>(() => {
    const languageRegion = config.language?.split('-')[1]?.toUpperCase();
    return languageRegion && languageRegion.length === 2 ? languageRegion : 'US';
  });
  const [streamingWatchRegions, setStreamingWatchRegions] = useState<TmdbWatchRegion[]>([]);
  const [isLoadingStreamingRegions, setIsLoadingStreamingRegions] = useState(false);
  const [availableStreamingProviders, setAvailableStreamingProviders] = useState<TmdbProvider[]>([]);
  const [isLoadingStreamingProviders, setIsLoadingStreamingProviders] = useState(false);
  const [streamingProviderFilter, setStreamingProviderFilter] = useState('');
  const [selectedStreamingServices, setSelectedStreamingServices] = useState<SelectedStreamingService[]>([]);
  const [streamingReleasedOnly, setStreamingReleasedOnly] = useState<boolean>(false);
  const [streamingDatePreset, setStreamingDatePreset] = useState<StreamingTimeRangePreset>('last_year');

  const [showMDBListModal, setShowMDBListModal] = useState(false);
  const [isValidatingApiKey, setIsValidatingApiKey] = useState(false);
  const easyGuideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mdblistModalResolve = useRef<((apiKey: string) => void) | null>(null);
  const mdblistModalReject = useRef<((error: Error) => void) | null>(null);

  const selectedPreset = useMemo(
    () => presetConfigs.find((preset) => preset.id === selectedPresetId) || null,
    [selectedPresetId]
  );

  const selectedCuratorLists = useMemo(
    () => loadedCuratorLists.filter((list) => selectedCuratorListKeys.has(list.selectionKey)),
    [loadedCuratorLists, selectedCuratorListKeys]
  );

  const builtInKeyAvailability = useMemo<Record<RequiredKeyId, boolean>>(
    () => ({
      tmdb: hasBuiltInTmdb,
      tvdb: hasBuiltInTvdb,
    }),
    [hasBuiltInTmdb, hasBuiltInTvdb]
  );

  const requiredPresetKeys = useMemo<RequiredKeyId[]>(() => {
    if (!selectedPreset) return [];

    const usedProviders = new Set<string>();

    Object.values(selectedPreset.config.providers || {}).forEach((value) => {
      if (typeof value === 'string') usedProviders.add(value.toLowerCase());
    });

    if (selectedPreset.config.search?.providers) {
      Object.values(selectedPreset.config.search.providers).forEach((value) => {
        if (typeof value === 'string') usedProviders.add(value.toLowerCase());
      });
    }

    if (selectedPreset.config.artProviders) {
      const artSources = Object.values(selectedPreset.config.artProviders)
        .filter((value) => typeof value !== 'boolean')
        .flatMap((value) => {
          if (typeof value === 'string') return [value.toLowerCase()];
          return Object.values(value).map((entry) => String(entry).toLowerCase());
        });
      artSources.forEach((source) => usedProviders.add(source));
    }

    const requiresTmdb = Array.from(usedProviders).some(
      (provider) => provider === 'tmdb' || provider.startsWith('tmdb.')
    );
    const requiresTvdb = Array.from(usedProviders).some(
      (provider) => provider === 'tvdb' || provider.startsWith('tvdb.')
    );

    const keys: RequiredKeyId[] = [];
    if (requiresTmdb) keys.push('tmdb');
    if (requiresTvdb) keys.push('tvdb');
    return keys;
  }, [selectedPreset]);

  const missingRequiredKeys = requiredPresetKeys.filter(
    (key) => {
      if (requiredKeyModes[key] === 'builtin') {
        return !builtInKeyAvailability[key];
      }
      return !requiredKeyInputs[key]?.trim();
    }
  );
  const requiredKeysSatisfied = requiredPresetKeys.length === 0 || missingRequiredKeys.length === 0;

  const displayOverridesValid =
    (!overrideMovieType || movieDisplayType.trim().length > 0) &&
    (!overrideSeriesType || seriesDisplayType.trim().length > 0);

  const canApplyWizard =
    !!selectedPreset &&
    displayOverridesValid &&
    requiredKeysSatisfied &&
    !isApplyingWizard &&
    !isExportingBackup;

  const availableStreamingProviderIds = useMemo(
    () => new Set(availableStreamingProviders.map((provider) => provider.provider_id)),
    [availableStreamingProviders]
  );

  const availablePopularStreamingServices = useMemo(
    () => popularStreamingServices.filter((service) =>
      service.providerIds.some((providerId) => availableStreamingProviderIds.has(providerId))
    ),
    [availableStreamingProviderIds]
  );

  const selectedServicesForCurrentRegion = useMemo(
    () => selectedStreamingServices.filter((service) => service.region === streamingWatchRegion),
    [selectedStreamingServices, streamingWatchRegion]
  );

  const selectedPopularServiceKeysForCurrentRegion = useMemo(
    () => new Set(
      selectedServicesForCurrentRegion
        .filter((service) => service.source === 'popular')
        .map((service) => {
          const parts = service.key.split(':');
          return parts.length >= 3 ? parts[1] : service.key;
        })
    ),
    [selectedServicesForCurrentRegion]
  );

  const selectedProviderIdsForCurrentRegion = useMemo(
    () => new Set(selectedServicesForCurrentRegion.flatMap((service) => service.providerIds)),
    [selectedServicesForCurrentRegion]
  );

  const selectedStreamingServiceCount = selectedStreamingServices.length;
  const canGenerateStreamingCatalogs = selectedStreamingServiceCount > 0;

  const selectedStreamingProviderNames = useMemo(
    () => selectedStreamingServices.map((service) => service.label).join(', '),
    [selectedStreamingServices]
  );
  const selectedStreamingServicesByRegion = useMemo(() => {
    const grouped: Record<string, SelectedStreamingService[]> = {};
    selectedStreamingServices.forEach((service) => {
      const region = service.region || 'Unknown';
      if (!grouped[region]) grouped[region] = [];
      grouped[region].push(service);
    });
    return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));
  }, [selectedStreamingServices]);

  const sortedStreamingRegions = useMemo(
    () => streamingWatchRegions
      .slice()
      .sort((a, b) => (a.english_name || a.iso_3166_1).localeCompare(b.english_name || b.iso_3166_1)),
    [streamingWatchRegions]
  );

  const filteredMissingStreamingProviders = useMemo(() => {
    const normalizedFilter = streamingProviderFilter.trim().toLowerCase();
    const ordered = availableStreamingProviders
      .slice()
      .sort((a, b) => a.provider_name.localeCompare(b.provider_name));

    return ordered.filter((provider) => {
      const providerName = provider.provider_name.trim();
      const normalizedProviderName = providerName.toLowerCase();
      if (predefinedStreamingProviderIds.has(provider.provider_id)) return false;
      if (normalizedProviderName.endsWith('amazon channel')) return false;
      if (normalizedProviderName.endsWith('apple tv channel')) return false;
      if (normalizedProviderName.endsWith('roku premium channel')) return false;
      if (!normalizedFilter) return true;
      return normalizedProviderName.includes(normalizedFilter);
    });
  }, [availableStreamingProviders, streamingProviderFilter]);

  const effectiveTmdbApiKey = useMemo(() => {
    const useBuiltIn = requiredKeyModes.tmdb === 'builtin' && builtInKeyAvailability.tmdb;
    if (useBuiltIn) return '';
    const stagedKey = (requiredKeyInputs.tmdb || '').trim();
    if (stagedKey) return stagedKey;
    return (config.apiKeys.tmdb || '').trim();
  }, [requiredKeyModes.tmdb, builtInKeyAvailability.tmdb, requiredKeyInputs.tmdb, config.apiKeys.tmdb]);

  const buildTmdbDiscoverRequestQuery = useCallback((params: Record<string, string>): string => {
    const searchParams = new URLSearchParams(params);
    if (effectiveTmdbApiKey) {
      searchParams.set('apikey', effectiveTmdbApiKey);
    }
    if (auth.userUUID) {
      searchParams.set('userUUID', auth.userUUID);
    }
    return searchParams.toString();
  }, [effectiveTmdbApiKey, auth.userUUID]);

  useEffect(() => {
    if (wizardStep < 4) return;
    if (streamingWatchRegions.length > 0) return;

    let cancelled = false;

    const loadWatchRegions = async () => {
      setIsLoadingStreamingRegions(true);
      try {
        const cacheKey = `preset_streaming_regions_${config.language || 'en-US'}`;
        const data = await apiCache.cachedFetch<{ watchRegions: TmdbWatchRegion[] }>(
          cacheKey,
          async () => {
            const response = await fetch(
              `/api/tmdb/discover/reference?${buildTmdbDiscoverRequestQuery({
                type: 'movie',
                language: config.language || 'en-US',
              })}`
            );
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.error || `Failed to load watch regions (${response.status})`);
            }
            return await response.json();
          },
          30 * 60 * 1000
        );

        if (cancelled) return;

        const regions = Array.isArray(data.watchRegions) ? data.watchRegions : [];
        setStreamingWatchRegions(regions);

        if (!regions.some((region) => region.iso_3166_1 === streamingWatchRegion)) {
          const fallbackRegion = regions.find((region) => region.iso_3166_1 === 'US')?.iso_3166_1
            || regions[0]?.iso_3166_1
            || 'US';
          setStreamingWatchRegion(fallbackRegion);
        }
      } catch (error) {
        if (cancelled) return;
        console.error('[Preset Wizard] Failed to load TMDB watch regions:', error);
        toast.error('Failed to load streaming regions', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      } finally {
        if (!cancelled) {
          setIsLoadingStreamingRegions(false);
        }
      }
    };

    void loadWatchRegions();

    return () => {
      cancelled = true;
    };
  }, [wizardStep, streamingWatchRegions.length, streamingWatchRegion, config.language, buildTmdbDiscoverRequestQuery]);

  useEffect(() => {
    if (wizardStep < 4) return;
    if (!streamingWatchRegion) {
      setAvailableStreamingProviders([]);
      return;
    }

    let cancelled = false;

    const loadProviders = async () => {
      setIsLoadingStreamingProviders(true);
      try {
        const cacheKey = `preset_streaming_providers_movie_${streamingWatchRegion}`;
        const data = await apiCache.cachedFetch<{ providers: TmdbProvider[] }>(
          cacheKey,
          async () => {
            const response = await fetch(
              `/api/tmdb/discover/providers?${buildTmdbDiscoverRequestQuery({
                type: 'movie',
                watch_region: streamingWatchRegion,
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

        const providers = Array.isArray(data.providers) ? data.providers : [];
        setAvailableStreamingProviders(providers);
      } catch (error) {
        if (cancelled) return;
        console.error('[Preset Wizard] Failed to load TMDB watch providers:', error);
        toast.error('Failed to load streaming providers', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      } finally {
        if (!cancelled) {
          setIsLoadingStreamingProviders(false);
        }
      }
    };

    void loadProviders();

    return () => {
      cancelled = true;
    };
  }, [wizardStep, streamingWatchRegion, buildTmdbDiscoverRequestQuery]);

  const clearEasyGuideTimer = useCallback(() => {
    if (easyGuideTimerRef.current) {
      clearTimeout(easyGuideTimerRef.current);
      easyGuideTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearEasyGuideTimer();
    };
  }, [clearEasyGuideTimer]);

  const resetGuidedFlowState = useCallback(() => {
    clearEasyGuideTimer();
    setGuidedAnswers({});
    setGuidedQuestionIndex(0);
    setShowEasyGuideSuccess(false);
    setGuidedSuccessTitle('That was easy!');
    setGuidedSuccessPresetName('');
  }, [clearEasyGuideTimer]);

  const completeGuidedPresetSelection = useCallback((presetId: string, successTitle: string) => {
    clearEasyGuideTimer();
    setSelectedPresetId(presetId);
    setExpandedPresetId(presetId);
    setGuidedSuccessTitle(successTitle);
    setGuidedSuccessPresetName(
      presetConfigs.find((preset) => preset.id === presetId)?.name || 'the selected preset'
    );
    setShowEasyGuideSuccess(true);
    easyGuideTimerRef.current = setTimeout(() => {
      setShowEasyGuideSuccess(false);
      setStepOneMode('cards');
      setWizardStep(2);
    }, 1300);
  }, [clearEasyGuideTimer]);

  const startGuidedPresetFlow = useCallback(() => {
    resetGuidedFlowState();
    setStepOneMode('guided');
  }, [resetGuidedFlowState]);

  const exitGuidedPresetFlow = useCallback(() => {
    resetGuidedFlowState();
    setStepOneMode('cards');
  }, [resetGuidedFlowState]);

  const handleGuidedBack = () => {
    if (showEasyGuideSuccess) return;

    if (guidedQuestionIndex <= 0) {
      exitGuidedPresetFlow();
      return;
    }

    if (guidedQuestionIndex === 1) {
      setGuidedQuestionIndex(0);
      setGuidedAnswers((previous) => ({
        ...previous,
        groupedSeasons: undefined,
        animeSource: undefined,
      }));
      return;
    }

    setGuidedQuestionIndex(1);
    setGuidedAnswers((previous) => ({
      ...previous,
      animeSource: undefined,
    }));
  };

  const handleGuidedAnimeFanAnswer = (answer: GuidedBinaryAnswer) => {
    setGuidedAnswers({ animeFan: answer });

    if (answer === 'no') {
      completeGuidedPresetSelection('movies-shows-only', 'That was easy!');
      return;
    }

    setShowEasyGuideSuccess(false);
    setGuidedQuestionIndex(1);
  };

  const handleGuidedGroupedSeasonsAnswer = (answer: GuidedBinaryAnswer) => {
    setGuidedAnswers((previous) => ({
      ...previous,
      groupedSeasons: answer,
      animeSource: undefined,
    }));

    setGuidedQuestionIndex(2);
  };

  const handleGuidedAnimeSourceAnswer = (source: GuidedAnimeSourceAnswer) => {
    setGuidedAnswers((previous) => ({
      ...previous,
      animeSource: source,
    }));
  
    const grouped = guidedAnswers.groupedSeasons === 'yes';
  
    if (grouped) {
      if (source === 'imdb') {
        completeGuidedPresetSelection('anime-lovers-mal', 'Great choice!');
        setGuidedAnswers((prev) => ({ ...prev, animeSource: 'imdb' }));
        return;
      }
  
      completeGuidedPresetSelection('anime-lovers-mal', 'Great choice!');
      return;
    }
  
    if (source === 'kitsu') {
      completeGuidedPresetSelection('movies-shows-anime-mal', 'Great choice!');
      return;
    }
  
    completeGuidedPresetSelection('movies-shows-anime-tvdb', 'Great choice!');
  };
  
  

  const toggleStreamingProvider = (provider: TmdbProvider) => {
    if (!streamingWatchRegion) return;
    const selectionKey = `custom:${provider.provider_id}:${streamingWatchRegion}`;
    const selectionLabel = `${provider.provider_name} (${streamingWatchRegion})`;

    setSelectedStreamingServices((previous) => {
      if (previous.some((item) => item.key === selectionKey)) {
        return previous.filter((item) => item.key !== selectionKey);
      }
      return [
        ...previous,
        {
          key: selectionKey,
          label: selectionLabel,
          providerIds: [provider.provider_id],
          watchProviders: [{ id: provider.provider_id, label: provider.provider_name }],
          region: streamingWatchRegion,
          source: 'custom',
        },
      ];
    });
  };

  const togglePopularStreamingService = (service: PopularStreamingService) => {
    if (!streamingWatchRegion) return;
    const resolvedProviderIds = service.providerIds.filter((providerId) => availableStreamingProviderIds.has(providerId));
    if (resolvedProviderIds.length === 0) return;
    const resolvedWatchProviders: SelectionItem[] = resolvedProviderIds.map((id) => {
      const matchedProvider = availableStreamingProviders.find((provider) => provider.provider_id === id);
      return {
        id,
        label: matchedProvider?.provider_name || service.label,
      };
    });

    const selectionKey = `popular:${service.key}:${streamingWatchRegion}`;
    const selectionLabel = `${service.label} (${streamingWatchRegion})`;

    setSelectedStreamingServices((previous) => {
      if (previous.some((item) => item.key === selectionKey)) {
        return previous.filter((item) => item.key !== selectionKey);
      }

      const withoutOverlappingCustoms = previous.filter((item) =>
        !(item.source === 'custom' && item.region === streamingWatchRegion && item.providerIds.some((id) => resolvedProviderIds.includes(id)))
      );

      return [
        ...withoutOverlappingCustoms,
        {
          key: selectionKey,
          label: selectionLabel,
          providerIds: resolvedProviderIds,
          watchProviders: resolvedWatchProviders,
          region: streamingWatchRegion,
          source: 'popular',
        },
      ];
    });
  };

  const testRequiredKey = async (key: RequiredKeyId) => {
    const rawValue = requiredKeyInputs[key] || '';
    const apiKeyValue = rawValue.trim();
    if (!apiKeyValue) {
      toast.error(`Enter ${requiredKeyConfig[key].label} before testing.`);
      return;
    }

    setRequiredKeyTestStatus((previous) => ({ ...previous, [key]: 'testing' }));
    setRequiredKeyTestMessage((previous) => ({ ...previous, [key]: '' }));

    try {
      const response = await fetch('/api/test-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiKeys: {
            [key]: apiKeyValue,
          },
        }),
      });

      const payload = await response.json().catch(() => ({} as {
        error?: string;
        details?: Record<string, { status?: string; reason?: string; message?: string }>;
      }));

      if (!response.ok) {
        throw new Error(payload.error || `Failed to test ${requiredKeyConfig[key].label}.`);
      }

      const detail = payload.details?.[key];
      if (detail?.status === 'valid') {
        setRequiredKeyTestStatus((previous) => ({ ...previous, [key]: 'valid' }));
        setRequiredKeyTestMessage((previous) => ({ ...previous, [key]: 'Key is valid.' }));
        toast.success(`${requiredKeyConfig[key].label} is valid.`);
        return;
      }

      if (detail?.status === 'invalid') {
        const message = detail.reason === 'quota_exhausted'
          ? 'Key is valid but quota is exhausted.'
          : (detail.message || 'Key validation failed.');
        setRequiredKeyTestStatus((previous) => ({ ...previous, [key]: 'invalid' }));
        setRequiredKeyTestMessage((previous) => ({ ...previous, [key]: message }));
        toast.error(`Invalid ${requiredKeyConfig[key].label.toLowerCase()}.`, { description: message });
        return;
      }

      if (detail?.status === 'timeout') {
        const message = detail.message || 'Validation timed out. Please try again.';
        setRequiredKeyTestStatus((previous) => ({ ...previous, [key]: 'timeout' }));
        setRequiredKeyTestMessage((previous) => ({ ...previous, [key]: message }));
        toast.error(`Testing ${requiredKeyConfig[key].label} timed out.`, { description: message });
        return;
      }

      const message = detail?.message || 'Unexpected validation response.';
      setRequiredKeyTestStatus((previous) => ({ ...previous, [key]: 'error' }));
      setRequiredKeyTestMessage((previous) => ({ ...previous, [key]: message }));
      toast.error(`Could not validate ${requiredKeyConfig[key].label.toLowerCase()}.`, { description: message });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error while testing key.';
      setRequiredKeyTestStatus((previous) => ({ ...previous, [key]: 'error' }));
      setRequiredKeyTestMessage((previous) => ({ ...previous, [key]: message }));
      toast.error(`Failed to test ${requiredKeyConfig[key].label.toLowerCase()}.`, { description: message });
    }
  };

  const handleExploreGuide = () => {
    if (typeof window === 'undefined') return;
    window.open('https://www.youtube.com/watch?v=AOxfOflZAsA', '_blank', 'noopener,noreferrer');
  };

  const testOptionalMDBListKey = async () => {
    const apiKeyValue = optionalMdblistKeyInput.trim();
    if (!apiKeyValue) {
      toast.error(`Enter ${optionalMDBListKeyConfig.label} before testing.`);
      return;
    }

    setOptionalMdblistKeyTestStatus('testing');
    setOptionalMdblistKeyTestMessage('');

    try {
      const response = await fetch('/api/test-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiKeys: {
            [optionalMDBListKeyConfig.id]: apiKeyValue,
          },
        }),
      });

      const payload = await response.json().catch(() => ({} as {
        error?: string;
        details?: Record<string, { status?: string; reason?: string; message?: string }>;
      }));

      if (!response.ok) {
        throw new Error(payload.error || `Failed to test ${optionalMDBListKeyConfig.label}.`);
      }

      const detail = payload.details?.[optionalMDBListKeyConfig.id];
      if (detail?.status === 'valid') {
        setOptionalMdblistKeyTestStatus('valid');
        setOptionalMdblistKeyTestMessage('Key is valid.');
        toast.success(`${optionalMDBListKeyConfig.label} is valid.`);
        return;
      }

      if (detail?.status === 'invalid') {
        const message = detail.reason === 'quota_exhausted'
          ? 'Key is valid but quota is exhausted.'
          : (detail.message || 'Key validation failed.');
        setOptionalMdblistKeyTestStatus('invalid');
        setOptionalMdblistKeyTestMessage(message);
        toast.error(`Invalid ${optionalMDBListKeyConfig.label.toLowerCase()}.`, { description: message });
        return;
      }

      if (detail?.status === 'timeout') {
        const message = detail.message || 'Validation timed out. Please try again.';
        setOptionalMdblistKeyTestStatus('timeout');
        setOptionalMdblistKeyTestMessage(message);
        toast.error(`Testing ${optionalMDBListKeyConfig.label} timed out.`, { description: message });
        return;
      }

      const message = detail?.message || 'Unexpected validation response.';
      setOptionalMdblistKeyTestStatus('error');
      setOptionalMdblistKeyTestMessage(message);
      toast.error(`Could not validate ${optionalMDBListKeyConfig.label.toLowerCase()}.`, { description: message });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error while testing key.';
      setOptionalMdblistKeyTestStatus('error');
      setOptionalMdblistKeyTestMessage(message);
      toast.error(`Failed to test ${optionalMDBListKeyConfig.label.toLowerCase()}.`, { description: message });
    }
  };

  const handleCuratorListSelection = (selectionKey: string, checked: boolean) => {
    const newSelection = new Set(selectedCuratorListKeys);
    if (checked) {
      newSelection.add(selectionKey);
    } else {
      newSelection.delete(selectionKey);
    }
    setSelectedCuratorListKeys(newSelection);
  };

  const loadCuratorLists = async (curator: CuratorProfile) => {
    let apiKey = optionalMdblistKeyInput.trim() || config.apiKeys.mdblist;
    if (!apiKey) {
      try {
        apiKey = await promptForMDBListAPIKey();
      } catch {
        toast.info('Curator list loading skipped', {
          description: 'MDBList API key is required to load trusted curator lists.',
        });
        return;
      }
    }

    setIsLoadingCuratorLists(true);
    setLoadingCuratorUsername(curator.username);

    try {
      const response = await fetch(
        `/api/mdblist/lists/user?apikey=${encodeURIComponent(apiKey)}&username=${encodeURIComponent(curator.username)}&sort=${userListSort}`
      );

      if (response.status === 401 || response.status === 403) {
        setConfig((prev) => ({
          ...prev,
          apiKeys: {
            ...prev.apiKeys,
            mdblist: '',
          },
        }));
        setOptionalMdblistKeyInput('');
        setOptionalMdblistKeyTestStatus('invalid');
        setOptionalMdblistKeyTestMessage('MDBList key appears invalid. Please update it and try again.');

        toast.error('Invalid MDBList API key', {
          description: 'The API key you provided is not valid. Please check your key and try again.',
        });
        return;
      }

      if (!response.ok) {
        throw new Error(`Failed to load lists (status ${response.status}).`);
      }

      const userLists = await response.json() as MDBListCollection[];
      if (!Array.isArray(userLists)) {
        throw new Error('Invalid response format from MDBList API.');
      }

      let filteredLists = userLists;
      if (curator.username === 'danaramapyjama') {
        filteredLists = userLists.filter((list) => list.name && list.name.toLowerCase().includes('wearers'));
      }

      const listsWithCurator: CuratorSelectableList[] = filteredLists
        .filter((list) => !!list.id && !!list.name)
        .map((list) => ({
          ...list,
          curatorName: curator.name,
          curatorUsername: curator.username,
          selectionKey: `${curator.username}:${String(list.id)}`,
        }));

      setLoadedCuratorLists((previous) => {
        const withoutCurator = previous.filter((list) => list.curatorUsername !== curator.username);
        return [...withoutCurator, ...listsWithCurator];
      });

      setSelectedCuratorListKeys((previous) => {
        const next = new Set(Array.from(previous).filter((key) => !key.startsWith(`${curator.username}:`)));
        return next;
      });

      if (listsWithCurator.length === 0) {
        toast.info('No lists found', {
          description: `No public lists available for ${curator.name}.`,
        });
      } else {
        toast.success('Curator lists loaded', {
          description: `Found ${listsWithCurator.length} list${listsWithCurator.length === 1 ? '' : 's'} from ${curator.name}.`,
        });
      }
    } catch (error) {
      console.error(`Error loading curator lists for ${curator.username}:`, error);
      toast.error('Failed to load curator lists', {
        description: error instanceof Error ? error.message : 'Unknown error occurred.',
      });
    } finally {
      setIsLoadingCuratorLists(false);
      setLoadingCuratorUsername(null);
    }
  };

  const promptForMDBListAPIKey = (): Promise<string> => {
    return new Promise((resolve, reject) => {
      mdblistModalResolve.current = resolve;
      mdblistModalReject.current = reject;
      setShowMDBListModal(true);
    });
  };

  const handleMDBListAPIKeySubmit = (apiKey: string) => {
    setIsValidatingApiKey(true);
    setOptionalMdblistKeyInput(apiKey);
    setOptionalMdblistKeyTestStatus('idle');
    setOptionalMdblistKeyTestMessage('');

    setConfig((prev) => ({
      ...prev,
      apiKeys: {
        ...prev.apiKeys,
        mdblist: apiKey,
      },
    }));

    setShowMDBListModal(false);
    setIsValidatingApiKey(false);

    if (mdblistModalResolve.current) {
      mdblistModalResolve.current(apiKey);
      mdblistModalResolve.current = null;
      mdblistModalReject.current = null;
    }
  };

  const handleMDBListAPIKeyCancel = () => {
    setShowMDBListModal(false);
    setIsValidatingApiKey(false);

    if (mdblistModalReject.current) {
      mdblistModalReject.current(new Error('User cancelled API key input'));
      mdblistModalResolve.current = null;
      mdblistModalReject.current = null;
    }
  };

  const buildPresetCatalogs = (presetId: string): CatalogConfig[] => {
    let presetCatalogs: CatalogConfig[] = allCatalogDefinitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      type: definition.type,
      source: definition.source as CatalogConfig['source'],
      enabled: definition.isEnabledByDefault || false,
      showInHome: definition.showOnHomeByDefault || false,
      sort: 'default',
      order: 'asc',
    }));

    if (presetId === 'movies-shows-only') {
      presetCatalogs = presetCatalogs.map((catalog) => {
        const isMalCatalog = catalog.source === 'mal';
        const isAnimeCatalog = catalog.type === 'anime';
        if (isMalCatalog || isAnimeCatalog) {
          return { ...catalog, enabled: false, showInHome: false };
        }
        return catalog;
      });
    }

    return presetCatalogs;
  };

  const getDisplayTypeOverrides = (): AppConfig['displayTypeOverrides'] => {
    const movieOverride = overrideMovieType && movieDisplayType.trim()
      ? movieDisplayType.trim()
      : undefined;
    const seriesOverride = overrideSeriesType && seriesDisplayType.trim()
      ? seriesDisplayType.trim()
      : undefined;

    if (!movieOverride && !seriesOverride) {
      return undefined;
    }

    return {
      movie: movieOverride,
      series: seriesOverride,
    };
  };

  const applyDisplayOverridesToCatalogs = (
    catalogs: CatalogConfig[],
    overrides: AppConfig['displayTypeOverrides']
  ): CatalogConfig[] => {
    if (!overrides?.movie && !overrides?.series) {
      return catalogs;
    }

    return catalogs.map((catalog) => {
      if (catalog.type === 'movie' && overrides.movie) {
        return { ...catalog, displayType: overrides.movie };
      }
      if (catalog.type === 'series' && overrides.series) {
        return { ...catalog, displayType: overrides.series };
      }
      return catalog;
    });
  };

  const buildStreamingServiceCatalogs = (): CatalogConfig[] => {
    if (selectedStreamingServices.length === 0) {
      return [];
    }

    const { from, to } = getStreamingDateRange(streamingDatePreset);
    const uniqueSuffix = Date.now().toString(36);
    const getServiceIdentity = (service: SelectedStreamingService): string => {
      const [source = 'unknown', idPart = service.key] = service.key.split(':');
      return `${source}:${idPart}`;
    };
    const stripRegionSuffix = (label: string, region: string): string => {
      const suffix = ` (${region})`;
      return label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
    };
    const serviceRegionsByIdentity = new Map<string, Set<string>>();
    selectedStreamingServices.forEach((service) => {
      const identity = getServiceIdentity(service);
      if (!serviceRegionsByIdentity.has(identity)) {
        serviceRegionsByIdentity.set(identity, new Set<string>());
      }
      serviceRegionsByIdentity.get(identity)!.add(service.region || '');
    });

      const buildStreamingCatalog = (
      provider: { ids: number[]; label: string; region: string; watchProviders: SelectionItem[] },
      mediaType: CatalogMediaType,
      slug: string,
      index: number
    ): CatalogConfig => {
      const isMovie = mediaType === 'movie';
      const tmdbMediaType = isMovie ? 'movie' : 'tv';
      const providerIdsJoined = provider.ids.join('|');

      const commonParams: Record<string, string | number | boolean> = {
        sort_by: 'popularity.desc',
        include_adult: false,
        watch_region: provider.region,
        with_watch_providers: providerIdsJoined,
        with_watch_monetization_types: 'flatrate|free|ads|rent|buy',
        'vote_count.gte': 10,
      };
      const params: Record<string, string | number | boolean> = isMovie
        ? {
            ...commonParams,
            'primary_release_date.gte': buildTmdbStreamingDateToken(streamingDatePreset, 'from'),
            'primary_release_date.lte': buildTmdbStreamingDateToken(streamingDatePreset, 'to'),
            ...(streamingReleasedOnly
              ? {
                  with_release_type: '4|5|6',
                  'release_date.lte': `${TMDB_DYNAMIC_DATE_TOKEN_PREFIX}:today:to`,
                }
              : {}),
          }
        : {
            ...commonParams,
            'first_air_date.gte': buildTmdbStreamingDateToken(streamingDatePreset, 'from'),
            'first_air_date.lte': buildTmdbStreamingDateToken(streamingDatePreset, 'to'),
            ...(streamingReleasedOnly
              ? {
                  with_status: '0|3|4|5',
                }
              : {}),
          };
      const discoverUrlParams: Record<string, string | number | boolean> = isMovie
        ? {
            ...commonParams,
            'primary_release_date.gte': from,
            'primary_release_date.lte': to,
            ...(streamingReleasedOnly
              ? {
                  with_release_type: '4|5|6',
                  'release_date.lte': to,
                }
              : {}),
          }
        : {
            ...commonParams,
            'first_air_date.gte': from,
            'first_air_date.lte': to,
            ...(streamingReleasedOnly
              ? {
                  with_status: '0|3|4|5',
                }
              : {}),
          };

      const providerIdsSlug = provider.ids.join('_');
      const catalogId = `tmdb.discover.${isMovie ? 'movie' : 'series'}.streaming_${slug}_${providerIdsSlug}_${index}.${uniqueSuffix}`;

      return {
        id: catalogId,
        type: mediaType,
        name: provider.label,
        enabled: true,
        showInHome: true,
        source: 'tmdb',
        cacheTTL: Math.max(catalogTTL, 300),
        metadata: {
          description: `TMDB Discover (${tmdbMediaType})`,
          url: buildTmdbDiscoverWebUrl(tmdbMediaType, discoverUrlParams),
          discover: {
            version: 2,
            source: 'tmdb',
            mediaType: tmdbMediaType,
            params,
            formState: {
              catalogName: provider.label,
              discoverSource: 'tmdb',
              catalogType: mediaType,
              tmdbMediaType,
              sortBy: 'popularity.desc',
              includeAdult: false,
              releasedOnly: streamingReleasedOnly,
              watchRegion: provider.region,
              watchProviders: provider.watchProviders,
              providerJoinMode: 'or',
              voteCountMin: 10,
              ...(isMovie
                ? {
                    primaryReleaseFrom: from,
                    primaryReleaseTo: to,
                    movieDatePreset: streamingDatePreset,
                  }
                : {
                    firstAirFrom: from,
                    firstAirTo: to,
                    seriesDatePreset: streamingDatePreset,
                  }),
            },
          },
        },
      };
    };

    const catalogs: CatalogConfig[] = [];
    const seenServiceKeys = new Set<string>();

    selectedStreamingServices.forEach((service, index) => {
      if (seenServiceKeys.has(service.key)) return;
      seenServiceKeys.add(service.key);
      const serviceIdentity = getServiceIdentity(service);
      const regionCount = serviceRegionsByIdentity.get(serviceIdentity)?.size || 0;
      const baseLabel = stripRegionSuffix(service.label, service.region);
      const providerLabel = regionCount > 1 ? `${baseLabel} (${service.region})` : baseLabel;
      const slug = providerLabel
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 30) || 'service';
      const provider = {
        ids: service.providerIds,
        label: providerLabel,
        region: service.region,
        watchProviders: service.watchProviders,
      };
      catalogs.push(buildStreamingCatalog(provider, 'movie', slug, index));
      catalogs.push(buildStreamingCatalog(provider, 'series', slug, index));
    });

    return catalogs;
  };

  const buildCuratorCatalogsFromSelections = (lists: CuratorSelectableList[]): CatalogConfig[] => {
    if (lists.length === 0) return [];

    const seenCatalogIds = new Set<string>();
    const importedCatalogs: CatalogConfig[] = [];

    lists.forEach((list) => {
      if (!list.id || !list.name) return;

      const type: CatalogConfig['type'] = list.mediatype === 'movie' ? 'movie' : 'series';
      const catalogId = `mdblist.${list.id}`;
      if (seenCatalogIds.has(catalogId)) return;
      seenCatalogIds.add(catalogId);

      const defaultDisplayType = list.curatorName === 'Dan Pyjama' && type === 'movie'
        ? 'film'
        : undefined;

      const username = (list.user_name || list.user || list.curatorUsername || '').toLowerCase().replace(/\s+/g, '');
      const listSlug = String(list.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const listUrl = username && listSlug ? `https://mdblist.com/lists/${username}/${listSlug}` : undefined;
      const author = list.user_name || list.curatorName || list.user;

      importedCatalogs.push({
        id: catalogId,
        type,
        name: String(list.name),
        enabled: true,
        showInHome: true,
        source: 'mdblist',
        sort: 'default',
        order: 'asc',
        cacheTTL: catalogTTL,
        genreSelection: 'standard',
        enableRatingPosters: true,
        ...(defaultDisplayType ? { displayType: defaultDisplayType } : {}),
        metadata: {
          ...(typeof list.items === 'number' ? { itemCount: list.items } : {}),
          ...(author ? { author } : {}),
          ...(listUrl ? { url: listUrl } : {}),
        },
      });
    });

    return importedCatalogs;
  };

  const goToNextStep = () => {
    if (wizardStep === 1 && stepOneMode === 'guided') {
      toast.error('Finish guided setup or exit it before continuing.');
      return;
    }
    if (wizardStep === 1 && !selectedPreset) {
      toast.error('Please choose a preset to continue.');
      return;
    }
    if (wizardStep === 2 && !displayOverridesValid) {
      toast.error('Please add a label for each enabled display override.');
      return;
    }
    if (wizardStep === 3 && !requiredKeysSatisfied) {
      toast.error('Add the required keys to continue.');
      return;
    }
    setWizardStep((previousStep) => Math.min(5, previousStep + 1) as WizardStep);
  };

  const goToPreviousStep = () => {
    setWizardStep((previousStep) => Math.max(1, previousStep - 1) as WizardStep);
  };

  const applyWizard = async () => {
    if (!selectedPreset) {
      setWizardStep(1);
      toast.error('Please select a preset first.');
      return;
    }
    if (!displayOverridesValid) {
      setWizardStep(2);
      toast.error('Please complete display override labels or disable the overrides.');
      return;
    }
    if (!requiredKeysSatisfied) {
      setWizardStep(3);
      toast.error('Add required keys before applying this preset.');
      return;
    }

    setIsApplyingWizard(true);
    try {
      let importedCatalogs: CatalogConfig[] = [];
      const generatedStreamingCatalogs = buildStreamingServiceCatalogs();
      const summaryParts: string[] = [];

      if (generatedStreamingCatalogs.length > 0) {
        summaryParts.push(
          `Added ${generatedStreamingCatalogs.length} streaming catalogs for ${selectedStreamingServiceCount} service${selectedStreamingServiceCount === 1 ? '' : 's'}.`
        );
      }

      if (selectedCuratorLists.length > 0) {
        importedCatalogs = buildCuratorCatalogsFromSelections(selectedCuratorLists);
        const curatorNames = Array.from(new Set(selectedCuratorLists.map((list) => list.curatorName))).join(', ');

        if (importedCatalogs.length > 0) {
          summaryParts.push(`Imported ${importedCatalogs.length} curated lists from ${curatorNames}.`);
        } else {
          summaryParts.push('No curated lists were imported.');
        }
      }

      const displayTypeOverrides = getDisplayTypeOverrides();
      const presetCatalogs = buildPresetCatalogs(selectedPreset.id);
      const finalCatalogs = applyDisplayOverridesToCatalogs(
        [...presetCatalogs, ...generatedStreamingCatalogs, ...importedCatalogs],
        displayTypeOverrides
      );

      setConfig((previousConfig) => {
        const nextConfig = { ...previousConfig };

        if (selectedPreset.config.providers) {
          nextConfig.providers = { ...previousConfig.providers, ...selectedPreset.config.providers };        
          if (guidedAnswers.groupedSeasons === 'yes' && guidedAnswers.animeSource === 'imdb') {
            nextConfig.providers.anime = 'imdb';
            nextConfig.providers.anime_id_provider = 'imdb';
          }
        }
        
        if (selectedPreset.config.artProviders) {
          nextConfig.artProviders = { ...previousConfig.artProviders, ...selectedPreset.config.artProviders };
        }
        if (selectedPreset.config.search) {
          nextConfig.search = {
            ...previousConfig.search,
            ...selectedPreset.config.search,
            providers: {
              ...previousConfig.search.providers,
              ...(selectedPreset.config.search.providers || {}),
            },
            engineEnabled: {
              ...(previousConfig.search.engineEnabled || {}),
              ...(selectedPreset.config.search.engineEnabled || {}),
            },
          };
        }
        if (selectedPreset.config.mal) {
          nextConfig.mal = { ...previousConfig.mal, ...selectedPreset.config.mal };
        }

        nextConfig.includeAdult = includeAdult;
        nextConfig.sfw = includeAdult ? false : (selectedPreset.config.sfw ?? true);
        nextConfig.displayTypeOverrides = displayTypeOverrides;
        nextConfig.apiKeys = {
          ...previousConfig.apiKeys,
          [optionalMDBListKeyConfig.id]: optionalMdblistKeyInput.trim(),
          ...requiredPresetKeys.reduce((accumulator, key) => {
            if (requiredKeyModes[key] === 'builtin' && builtInKeyAvailability[key]) {
              accumulator[key] = '';
            } else {
              accumulator[key] = requiredKeyInputs[key]?.trim() || '';
            }
            return accumulator;
          }, {} as Pick<AppConfig['apiKeys'], RequiredKeyId>),
        };
        nextConfig.catalogSetupComplete = true;
        nextConfig.catalogs = finalCatalogs;

        return nextConfig;
      });

      setLastAppliedPresetId(selectedPreset.id);
      const summaryText = summaryParts.join(' ');
      const summarySuffix = summaryText ? ` ${summaryText}` : '';
      setApplySuccessSummary(summaryText);
      setShowApplySuccessDialog(true);
      toast.success('Preset wizard applied', {
        description: `Applied "${selectedPreset.name}".${summarySuffix} Do not forget to save in Configuration Manager.`,
        duration: 5000,
      });
    } catch (error) {
      console.error('Failed to apply preset wizard:', error);
      toast.error('Failed to apply preset wizard', {
        description: 'Please try again. Your current configuration is still intact.',
      });
    } finally {
      setIsApplyingWizard(false);
    }
  };

  const exportCurrentConfigurationBackup = (): boolean => {
    setIsExportingBackup(true);
    try {
      exportConfigFile(config, {
        addonVersion,
        excludeApiKeys: false,
      });

      toast.success('Configuration backup exported', {
        description: 'Full configuration exported with API keys included.',
      });
      return true;
    } catch (error) {
      console.error('Failed to export configuration backup:', error);
      toast.error('Failed to export configuration backup', {
        description: 'Preset was not applied. Please try again.',
      });
      return false;
    } finally {
      setIsExportingBackup(false);
    }
  };

  const handleApplyPresetClick = () => {
    if (isApplyingWizard || isExportingBackup) return;

    if (!auth.userUUID) {
      void applyWizard();
      return;
    }

    setShowBackupDialog(true);
  };

  const handleApplyWithBackup = () => {
    const backupSucceeded = exportCurrentConfigurationBackup();
    setShowBackupDialog(false);
    if (!backupSucceeded) return;
    void applyWizard();
  };

  const handleApplyWithoutBackup = () => {
    setShowBackupDialog(false);
    void applyWizard();
  };

  const handleCancelApply = () => {
    setShowBackupDialog(false);
  };

  const navigateToSettingsTab = (tab: 'catalogs' | 'configuration') => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(SETTINGS_LAYOUT_NAVIGATE_EVENT, {
          detail: { tab, scrollToTop: true },
        })
      );
    }
    setShowApplySuccessDialog(false);
  };

  const selectedCuratorListCount = selectedCuratorLists.length;
  const selectedCuratorNames = Array.from(new Set(selectedCuratorLists.map((list) => list.curatorName))).join(', ');
  const applyActionLabel = (() => {
    const hasStreaming = canGenerateStreamingCatalogs;
    const hasCurators = selectedCuratorListCount > 0;
    if (hasStreaming && hasCurators) return 'Apply preset, streaming catalogs, and lists';
    if (hasStreaming) return 'Apply preset and add streaming catalogs';
    if (hasCurators) return 'Apply preset and import lists';
    return 'Apply preset';
  })();
  const displayTypeSummary = [
    overrideMovieType && movieDisplayType.trim() ? `Movies -> ${movieDisplayType.trim()}` : null,
    overrideSeriesType && seriesDisplayType.trim() ? `Series -> ${seriesDisplayType.trim()}` : null,
  ].filter(Boolean).join(' | ');

  const activeStepMeta = wizardStepConfig.find((step) => step.id === wizardStep);
  const hasReachedSafetyStep = wizardStep >= 2;
  const hasReachedKeysStep = wizardStep >= 3;
  const hasReachedStreamingStep = wizardStep >= 4;
  const hasReachedCuratorsStep = wizardStep >= 5;

  const renderStepActions = () => (
    <div className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-4 sm:flex-row sm:items-center">
      {wizardStep > 1 && (
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          onClick={goToPreviousStep}
          disabled={isApplyingWizard || isExportingBackup}
        >
          Back
        </Button>
      )}
      {wizardStep < 5 ? (
        <Button
          className="w-full whitespace-normal text-center sm:ml-auto sm:w-auto"
          onClick={goToNextStep}
          disabled={
            isApplyingWizard ||
            isExportingBackup ||
            (wizardStep === 1 && (stepOneMode === 'guided' || !selectedPreset)) ||
            (wizardStep === 2 && !displayOverridesValid) ||
            (wizardStep === 3 && !requiredKeysSatisfied)
          }
        >
          Continue
        </Button>
      ) : (
        <Button className="w-full whitespace-normal text-center sm:ml-auto sm:w-auto" onClick={handleApplyPresetClick} disabled={!canApplyWizard}>
          {isExportingBackup
            ? 'Exporting backup...'
            : isApplyingWizard
            ? 'Applying wizard...'
            : applyActionLabel}
        </Button>
      )}
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 animate-fade-in">
      <Card className="overflow-hidden border border-primary/10 bg-gradient-to-br from-primary/5 via-background to-background shadow-sm">
        <CardContent className="p-6 md:p-8 lg:p-10">
          <div className="flex flex-col gap-6">
            <div className="max-w-4xl space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                <Sparkles className="h-4 w-4" />
                Guided setup
              </div>
              <div className="space-y-2">
                <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Preset Wizard</h2>
                <p className="text-base leading-relaxed text-muted-foreground">
                  Pick a preset, choose safety and labels, optionally add streaming-service discover catalogs, and optionally import trusted MDBList collections.
                  Your selections are applied in order, and display label overrides are applied last.
                </p>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-center">
              <div className="rounded-lg border border-border/60 bg-background/60 px-4 py-3">
                <p className="text-sm text-muted-foreground">
                  For optimal Stremio behavior, use{' '}
                  <a
                    href="https://cinebye.dinsden.top/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group relative inline-flex items-center gap-1 text-primary underline underline-offset-4 transition"
                  >
                    <span>Cinebye</span>
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-primary/80 transition-transform duration-300 group-hover:scale-x-100" aria-hidden="true" />
                  </a>{' '}to deactivate Cinemeta metadata.
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row lg:min-w-[240px] lg:flex-col">
                <Button onClick={handleExploreGuide} className="gap-2">
                  <PlayCircle className="h-4 w-4" />
                  Watch the Elfhosted guide
                </Button>
                <div className="inline-flex items-center justify-center gap-2 rounded-md border border-border/60 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
                  <ShieldCheck className="h-4 w-4" />
                  Presets can be adjusted any time.
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">Step {wizardStep} of 5</p>
            <p className="text-xs text-muted-foreground">{activeStepMeta?.hint}</p>
          </div>
          <div className="grid gap-2 md:grid-cols-5">
            {wizardStepConfig.map((step) => {
              const isActive = wizardStep === step.id;
              const isComplete = wizardStep > step.id;
              const canJump = step.id <= wizardStep;
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => canJump && setWizardStep(step.id)}
                  disabled={!canJump}
                  aria-current={isActive ? 'step' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                    isActive && 'border-primary bg-primary/5 text-primary',
                    isComplete && 'border-emerald-500/50 bg-emerald-500/5 text-emerald-700',
                    !isActive && !isComplete && 'border-border text-muted-foreground',
                    canJump && 'hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                    !canJump && 'cursor-not-allowed opacity-70'
                  )}
                >
                  <span className={cn(
                    'inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-semibold',
                    isActive && 'bg-primary text-primary-foreground',
                    isComplete && 'bg-emerald-600 text-white',
                    !isActive && !isComplete && 'bg-muted text-muted-foreground'
                  )}>
                    {isComplete ? <CheckCircle2 className="h-3.5 w-3.5" /> : step.id}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="font-medium truncate">{step.label}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {wizardStep === 1 && (
        <Card className="animate-in fade-in-0 slide-in-from-right-2 duration-300">
          <CardHeader>
            <CardTitle>
              {stepOneMode === 'guided'
                ? 'Step 1: Guided preset selection'
                : 'Step 1: Which preset would you like?'}
            </CardTitle>
            <CardDescription>
              {stepOneMode === 'guided'
                ? 'Answer a few quick questions and we will pick the preset for you.'
                : 'Start by selecting a preset. This sets metadata providers, search defaults, and the initial catalog lineup.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {stepOneMode === 'cards' ? (
              <>
                <div className="grid gap-4 lg:grid-cols-2">
                  {presetConfigs.map((preset) => {
                    const isSelected = selectedPresetId === preset.id;
                    const isLastApplied = lastAppliedPresetId === preset.id;
                    const isExpanded = expandedPresetId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setSelectedPresetId(preset.id);
                          setExpandedPresetId(preset.id);
                        }}
                        aria-pressed={isSelected}
                        className={cn(
                          'rounded-xl border p-4 text-left transition-all hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                          isSelected ? 'border-primary ring-1 ring-primary/50 bg-primary/5 shadow-sm' : 'border-border bg-background'
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex flex-1 min-w-0 items-start gap-3">
                            <div className={cn(
                              'flex h-10 w-10 items-center justify-center rounded-lg bg-muted transition-colors',
                              isSelected && 'bg-primary/15 text-primary'
                            )}>
                              {preset.icon}
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold break-words">{preset.name}</p>
                              <p className="text-xs text-muted-foreground">{preset.tagline}</p>
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-2">
                            <Badge className={cn('text-white whitespace-nowrap text-[11px]', preset.badgeColor)}>{preset.badge}</Badge>
                            {isLastApplied && <span className="text-xs text-emerald-600 font-medium">Last applied</span>}
                          </div>
                        </div>
                        <div
                          className={cn(
                            'overflow-hidden transition-all duration-300 ease-out',
                            isExpanded ? 'mt-3 max-h-56 opacity-100' : 'max-h-0 opacity-0'
                          )}
                        >
                          <ul className="space-y-1 text-xs text-muted-foreground">
                            {preset.highlights.map((highlight) => (
                              <li key={highlight} className="flex items-start gap-2">
                                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-primary flex-shrink-0" />
                                <span>{highlight}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Not sure what to choose?</p>
                      <p className="text-xs text-muted-foreground">Answer a few questions and we will choose for you.</p>
                    </div>
                    <Button type="button" variant="outline" className="sm:min-w-64" onClick={startGuidedPresetFlow}>
                      I don't know what I want, guide me!
                    </Button>
                  </div>
                </div>
                {renderStepActions()}
              </>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Guided preset selection</p>
                    <p className="text-xs text-muted-foreground">A few quick answers and we will set the right preset.</p>
                    {(guidedAnswers.animeFan || guidedAnswers.groupedSeasons) && !showEasyGuideSuccess && (
                      <p className="text-[11px] text-muted-foreground">
                        {guidedAnswers.animeFan ? `Anime fan: ${guidedAnswers.animeFan === 'yes' ? 'Yes' : 'No'}` : ''}
                        {guidedAnswers.groupedSeasons
                          ? ` | Grouped seasons: ${guidedAnswers.groupedSeasons === 'yes' ? 'Yes' : 'No'}`
                          : ''}
                      </p>
                    )}
                  </div>
                  {!showEasyGuideSuccess && (
                    <Badge variant="outline" className="text-[11px]">
                      Question {Math.min(guidedQuestionIndex + 1, 3)} of 3
                    </Badge>
                  )}
                </div>

                {showEasyGuideSuccess ? (
                  <div className="animate-in fade-in-0 zoom-in-95 duration-300 rounded-lg border border-emerald-300/60 bg-emerald-50/70 px-4 py-4 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-100">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5" />
                      <p className="text-sm font-semibold">{guidedSuccessTitle}</p>
                    </div>
                    <p className="mt-1 text-xs">
                      Selected <span className="font-semibold">{guidedSuccessPresetName || 'the selected preset'}</span>. Taking you to the next step...
                    </p>
                  </div>
                ) : (
                  <>
                    {guidedQuestionIndex === 0 && (
                      <div className="animate-in fade-in-0 slide-in-from-right-2 duration-300 rounded-lg border border-border/60 bg-background/70 p-4 space-y-4">
                        <div className="space-y-1">
                          <p className="text-base font-medium">Are you an anime fan?</p>
                          <p className="text-sm text-muted-foreground">This decides whether anime catalogs and anime search are included.</p>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Button type="button" variant="outline" className="justify-start" onClick={() => handleGuidedAnimeFanAnswer('yes')}>
                            Yes, include anime
                          </Button>
                          <Button type="button" variant="outline" className="justify-start" onClick={() => handleGuidedAnimeFanAnswer('no')}>
                            No, skip anime
                          </Button>
                        </div>
                      </div>
                    )}

                    {guidedQuestionIndex === 1 && (
                      <div className="animate-in fade-in-0 slide-in-from-right-2 duration-300 rounded-lg border border-border/60 bg-background/70 p-4 space-y-4">
                        <div className="space-y-1">
                          <p className="text-base font-medium">Do you prefer grouped seasons for anime?</p>
                          <p className="text-sm text-muted-foreground">Grouped seasons work better for anime-first libraries.</p>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Button type="button" variant="outline" className="justify-start" onClick={() => handleGuidedGroupedSeasonsAnswer('yes')}>
                            Yes, grouped seasons
                          </Button>
                          <Button type="button" variant="outline" className="justify-start" onClick={() => handleGuidedGroupedSeasonsAnswer('no')}>
                            No, Split cour
                          </Button>
                        </div>
                      </div>
                    )}

                    {guidedQuestionIndex === 2 && (
                      <div className="animate-in fade-in-0 slide-in-from-right-2 duration-300 rounded-lg border border-border/60 bg-background/70 p-4 space-y-4">
                        <div className="space-y-1">
                          <p className="text-base font-medium">
                            Which anime metadata source do you prefer?
                          </p>

                          {guidedAnswers.groupedSeasons === 'yes' ? (
                            <p className="text-sm text-muted-foreground">
                              TVDB matching works best with grouped seasons. IMDB is the alternative.
                            </p>
                          ) : (
                            <p className="text-sm text-muted-foreground">
                              Kitsu is anime-focused. TVDB is a safe, broad default.
                            </p>
                          )}
                        </div>

                        <div className="grid gap-2 sm:grid-cols-2">
                          {guidedAnswers.groupedSeasons === 'yes' ? (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                className="justify-start"
                                onClick={() => handleGuidedAnimeSourceAnswer('tvdb')}
                              >
                                TVDB
                              </Button>

                              <Button
                                type="button"
                                variant="outline"
                                className="justify-start"
                                onClick={() => handleGuidedAnimeSourceAnswer('imdb')}
                              >
                                IMDB
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                className="justify-start"
                                onClick={() => handleGuidedAnimeSourceAnswer('kitsu')}
                              >
                                Kitsu
                              </Button>

                              <Button
                                type="button"
                                variant="outline"
                                className="justify-start"
                                onClick={() => handleGuidedAnimeSourceAnswer('tvdb')}
                              >
                                TVDB
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    )}


                    <div className="flex items-center justify-between">
                      <Button type="button" variant="ghost" onClick={handleGuidedBack}>
                        Back question
                      </Button>
                      <Button type="button" variant="outline" onClick={exitGuidedPresetFlow}>
                        Exit guide
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {wizardStep === 2 && (
        <Card className="animate-in fade-in-0 slide-in-from-right-2 duration-300">
          <CardHeader>
            <CardTitle>Step 2: Safe viewing and catalog label overrides</CardTitle>
            <CardDescription>
              Choose safety preferences and optional display labels. Label overrides are applied at the end of the wizard.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label htmlFor="include-adult" className="text-base font-medium">Include adult content</Label>
                  <p className="text-sm text-muted-foreground">
                    Recommended off, strictly filters out not safe for work content.
                  </p>
                </div>
                <Switch
                  id="include-adult"
                  checked={includeAdult}
                  onCheckedChange={setIncludeAdult}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="override-movie" className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Movies label</Label>
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="inline-flex text-muted-foreground hover:text-foreground"
                              aria-label="Movies label override help"
                            >
                              <CircleHelp className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm text-xs">
                            {LABEL_OVERRIDE_TOOLTIP_TEXT}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <p className="text-sm text-muted-foreground">Example: film, films, feature</p>
                  </div>
                  <Switch
                    id="override-movie"
                    checked={overrideMovieType}
                    onCheckedChange={setOverrideMovieType}
                  />
                </div>
                <Input
                  id="movie-display-type"
                  value={movieDisplayType}
                  onChange={(event) => setMovieDisplayType(event.target.value)}
                  placeholder="e.g., film"
                  disabled={!overrideMovieType}
                />
              </div>

              <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Label htmlFor="override-series" className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Series label</Label>
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="inline-flex text-muted-foreground hover:text-foreground"
                              aria-label="Series label override help"
                            >
                              <CircleHelp className="h-3.5 w-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm text-xs">
                            {LABEL_OVERRIDE_TOOLTIP_TEXT}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <p className="text-sm text-muted-foreground">Example: shows, tv shows, dramas</p>
                  </div>
                  <Switch
                    id="override-series"
                    checked={overrideSeriesType}
                    onCheckedChange={setOverrideSeriesType}
                  />
                </div>
                <Input
                  id="series-display-type"
                  value={seriesDisplayType}
                  onChange={(event) => setSeriesDisplayType(event.target.value)}
                  placeholder="e.g., shows"
                  disabled={!overrideSeriesType}
                />
              </div>
            </div>

            {!displayOverridesValid && (
              <div className="rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-100">
                Enter a label for each enabled override before continuing.
              </div>
            )}
            {renderStepActions()}
          </CardContent>
        </Card>
      )}

      {wizardStep === 3 && (
        <Card className="animate-in fade-in-0 slide-in-from-right-2 duration-300">
          <CardHeader>
            <CardTitle>Step 3: Required keys for this preset</CardTitle>
            <CardDescription>
              Add the API keys required by your selected preset. You can also add optional integrations like MDBList. These are saved only when you press Apply Preset.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {requiredPresetKeys.length === 0 ? (
              <div className="rounded-lg border border-emerald-300/60 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-100">
                No required keys detected for this preset.
              </div>
            ) : (
              <div className="space-y-4">
                {requiredPresetKeys.map((key) => {
                  const hasBuiltIn = builtInKeyAvailability[key];
                  const useBuiltIn = requiredKeyModes[key] === 'builtin' && hasBuiltIn;

                  return (
                    <div key={key} className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <Label htmlFor={`required-key-${key}`} className="text-sm font-medium">
                          {requiredKeyConfig[key].label}
                        </Label>
                        <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
                          {requiredKeyConfig[key].linkHref && (
                            <a
                              href={requiredKeyConfig[key].linkHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-muted-foreground hover:text-foreground hover:underline sm:text-sm"
                            >
                              Get Key
                            </a>
                          )}
                          {hasBuiltIn && (
                            <div className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-background/80 p-1 sm:inline-flex sm:w-auto">
                              <Button
                                type="button"
                                size="sm"
                                variant={useBuiltIn ? 'default' : 'ghost'}
                                className="flex-1 sm:flex-none"
                                onClick={() => {
                                  setRequiredKeyModes((previous) => ({
                                    ...previous,
                                    [key]: 'builtin',
                                  }));
                                  setRequiredKeyTestStatus((previous) => ({ ...previous, [key]: 'idle' }));
                                  setRequiredKeyTestMessage((previous) => ({ ...previous, [key]: '' }));
                                }}
                              >
                                Use built-in
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant={useBuiltIn ? 'ghost' : 'default'}
                                className="flex-1 sm:flex-none"
                                onClick={() => {
                                  setRequiredKeyModes((previous) => ({
                                    ...previous,
                                    [key]: 'custom',
                                  }));
                                  setRequiredKeyTestStatus((previous) => ({ ...previous, [key]: 'idle' }));
                                  setRequiredKeyTestMessage((previous) => ({ ...previous, [key]: '' }));
                                }}
                              >
                                Use my key
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>

                      {!useBuiltIn && (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <Input
                            id={`required-key-${key}`}
                            value={requiredKeyInputs[key]}
                            onChange={(event) => {
                              setRequiredKeyInputs((previous) => ({
                                ...previous,
                                [key]: event.target.value,
                              }));
                              setRequiredKeyModes((previous) => ({
                                ...previous,
                                [key]: 'custom',
                              }));
                              setRequiredKeyTestStatus((previous) => ({ ...previous, [key]: 'idle' }));
                              setRequiredKeyTestMessage((previous) => ({ ...previous, [key]: '' }));
                            }}
                            placeholder={requiredKeyConfig[key].placeholder}
                            spellCheck={false}
                            autoCorrect="off"
                            autoCapitalize="off"
                            className="sm:flex-1"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="sm:min-w-28"
                            disabled={requiredKeyTestStatus[key] === 'testing' || !requiredKeyInputs[key]?.trim()}
                            onClick={() => {
                              void testRequiredKey(key);
                            }}
                          >
                            {requiredKeyTestStatus[key] === 'testing' ? (
                              <>
                                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                Testing...
                              </>
                            ) : (
                              'Test key'
                            )}
                          </Button>
                        </div>
                      )}

                      {!useBuiltIn && requiredKeyTestStatus[key] !== 'idle' && (
                        <p className={cn(
                          'text-xs',
                          requiredKeyTestStatus[key] === 'valid' && 'text-emerald-700 dark:text-emerald-300',
                          (requiredKeyTestStatus[key] === 'invalid' || requiredKeyTestStatus[key] === 'timeout' || requiredKeyTestStatus[key] === 'error')
                            && 'text-amber-700 dark:text-amber-300',
                          requiredKeyTestStatus[key] === 'testing' && 'text-muted-foreground'
                        )}>
                          {requiredKeyTestMessage[key]}
                        </p>
                      )}

                      <p className="text-xs text-muted-foreground">
                        {requiredKeyConfig[key].helper}
                        {hasBuiltIn ? ' Built-in key detected; choose built-in or your own key.' : ''}
                      </p>
                    </div>
                  );
                })}

                {!requiredKeysSatisfied && (
                  <div className="rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-100">
                    Missing required keys: {missingRequiredKeys.map((key) => requiredKeyConfig[key].label).join(', ')}
                  </div>
                )}
              </div>
            )}

            <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <Label htmlFor="optional-mdblist-key" className="text-sm font-medium">
                    {optionalMDBListKeyConfig.label}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Optional integration
                  </p>
                </div>
                <a
                  href={optionalMDBListKeyConfig.linkHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  Get Key
                </a>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  id="optional-mdblist-key"
                  value={optionalMdblistKeyInput}
                  onChange={(event) => {
                    setOptionalMdblistKeyInput(event.target.value);
                    setOptionalMdblistKeyTestStatus('idle');
                    setOptionalMdblistKeyTestMessage('');
                  }}
                  placeholder={optionalMDBListKeyConfig.placeholder}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  className="sm:flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="sm:min-w-28"
                  disabled={optionalMdblistKeyTestStatus === 'testing' || !optionalMdblistKeyInput.trim()}
                  onClick={() => {
                    void testOptionalMDBListKey();
                  }}
                >
                  {optionalMdblistKeyTestStatus === 'testing' ? (
                    <>
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      Testing...
                    </>
                  ) : (
                    'Test key'
                  )}
                </Button>
              </div>

              {optionalMdblistKeyTestStatus !== 'idle' && (
                <p className={cn(
                  'text-xs',
                  optionalMdblistKeyTestStatus === 'valid' && 'text-emerald-700 dark:text-emerald-300',
                  (optionalMdblistKeyTestStatus === 'invalid' || optionalMdblistKeyTestStatus === 'timeout' || optionalMdblistKeyTestStatus === 'error')
                    && 'text-amber-700 dark:text-amber-300',
                  optionalMdblistKeyTestStatus === 'testing' && 'text-muted-foreground'
                )}>
                  {optionalMdblistKeyTestMessage}
                </p>
              )}

              <p className="text-xs text-muted-foreground">
                {optionalMDBListKeyConfig.helper}
              </p>
            </div>
            {renderStepActions()}
          </CardContent>
        </Card>
      )}

      {wizardStep === 4 && (
        <Card className="animate-in fade-in-0 slide-in-from-right-2 duration-300">
          <CardHeader>
            <CardTitle>Step 4: Streaming services quick setup</CardTitle>
            <CardDescription>
              Add TMDB discover catalogs for popular services. One Movies and one Series catalog are created per selected service.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="streaming-watch-region">Watch Region</Label>
                <Select
                  value={streamingWatchRegion || NONE_VALUE}
                  onValueChange={(value) => {
                    const nextRegion = value === NONE_VALUE ? '' : value;
                    setStreamingWatchRegion(nextRegion);
                    if (!nextRegion) {
                      setAvailableStreamingProviders([]);
                    }
                    setStreamingProviderFilter('');
                  }}
                >
                  <SelectTrigger id="streaming-watch-region" className="w-full sm:w-72">
                    <SelectValue placeholder="Select region" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_VALUE}>Any</SelectItem>
                    {sortedStreamingRegions.map((region) => (
                      <SelectItem key={region.iso_3166_1} value={region.iso_3166_1}>
                        {(region.english_name || region.iso_3166_1)} ({region.iso_3166_1})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {isLoadingStreamingRegions && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading available regions...
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-sm">Popular services</Label>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {availablePopularStreamingServices.map((service) => {
                    const selected = selectedPopularServiceKeysForCurrentRegion.has(service.key);
                    return (
                      <Button
                        key={service.key}
                        type="button"
                        variant={selected ? 'default' : 'outline'}
                        disabled={!streamingWatchRegion}
                        className="justify-start gap-2 min-w-0"
                        onClick={() => togglePopularStreamingService(service)}
                      >
                        {popularStreamingServiceIcons[service.key] ? (
                          <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border/50 bg-background">
                            <img
                              src={popularStreamingServiceIcons[service.key] as string}
                              alt={`${service.label} icon`}
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          </span>
                        ) : (
                          <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm border border-border/50 bg-muted text-[10px] font-semibold text-muted-foreground">
                            ?
                          </span>
                        )}
                        <span className="truncate">{service.label}</span>
                      </Button>
                    );
                  })}
                </div>
                {!isLoadingStreamingProviders && streamingWatchRegion && availablePopularStreamingServices.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No predefined popular services are available for this region.
                  </p>
                )}
                {isLoadingStreamingProviders && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading providers for {streamingWatchRegion || 'selected region'}...
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="streaming-provider-search">Missing a service?</Label>
                <Input
                  id="streaming-provider-search"
                  placeholder="Search providers..."
                  value={streamingProviderFilter}
                  onChange={(event) => setStreamingProviderFilter(event.target.value)}
                  disabled={!streamingWatchRegion || isLoadingStreamingProviders}
                />

                {!isLoadingStreamingProviders && streamingWatchRegion && filteredMissingStreamingProviders.length > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-56 overflow-y-auto rounded-md border p-2">
                    {filteredMissingStreamingProviders.map((provider) => {
                      const selected = selectedProviderIdsForCurrentRegion.has(provider.provider_id);
                      return (
                        <Button
                          key={provider.provider_id}
                          type="button"
                          size="sm"
                          variant={selected ? 'default' : 'outline'}
                          className="justify-start"
                          onClick={() => toggleStreamingProvider(provider)}
                        >
                          <span className="truncate">{provider.provider_name}</span>
                        </Button>
                      );
                    })}
                  </div>
                )}

                {!isLoadingStreamingProviders && streamingWatchRegion && filteredMissingStreamingProviders.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No additional providers found for this region.
                  </p>
                )}
              </div>

              <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="streaming-time-range" className="text-sm font-medium">
                    Time range
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Applies to both Movies and Series generated catalogs.
                  </p>
                  <Select
                    value={streamingDatePreset}
                    onValueChange={(value: StreamingTimeRangePreset) => setStreamingDatePreset(value)}
                  >
                    <SelectTrigger id="streaming-time-range" className="w-full sm:w-56">
                      <SelectValue placeholder="Select time range" />
                    </SelectTrigger>
                    <SelectContent>
                      {STREAMING_TIME_RANGE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="streaming-released-only" className="text-sm font-medium">
                      Released only
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Applies the released-only filters to both Movies and Series catalogs.
                    </p>
                  </div>
                  <Switch
                    id="streaming-released-only"
                    checked={streamingReleasedOnly}
                    onCheckedChange={setStreamingReleasedOnly}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-md border border-dashed border-border/70 bg-background/70 p-3">
              <p className="text-xs text-muted-foreground mb-2">Selected services</p>
              {selectedStreamingServiceCount === 0 ? (
                <p className="text-xs text-muted-foreground">No streaming service selected. This step will be skipped.</p>
              ) : (
                <div className="space-y-3">
                  {selectedStreamingServicesByRegion.map(([region, services]) => (
                    <div key={region} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="h-5 px-2 text-[10px]">{region}</Badge>
                        <span className="text-[11px] text-muted-foreground">
                          {services.length} service{services.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {services.map((service) => {
                          const suffix = ` (${region})`;
                          const displayLabel = service.label.endsWith(suffix)
                            ? service.label.slice(0, -suffix.length)
                            : service.label;
                          return (
                            <Badge key={service.key} variant="secondary" className="gap-2">
                              <span>{displayLabel}</span>
                              <button
                                type="button"
                                className="rounded-sm px-1 text-xs hover:bg-background/60"
                                onClick={() => setSelectedStreamingServices((previous) => previous.filter((item) => item.key !== service.key))}
                                aria-label={`Remove ${service.label}`}
                              >
                                x
                              </button>
                            </Badge>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {renderStepActions()}
          </CardContent>
        </Card>
      )}

      {wizardStep === 5 && (
        <Card className="animate-in fade-in-0 slide-in-from-right-2 duration-300">
          <CardHeader>
            <CardTitle>Step 5: Import trusted curator MDBList collections</CardTitle>
            <CardDescription>
              Optional step. Load lists from trusted curators, then choose exactly which lists to import.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-4 rounded-lg border border-border/60 bg-muted/20 p-4">
              <div className="space-y-1">
                <p className="text-base font-medium">Trusted curators</p>
                <p className="text-sm text-muted-foreground">
                  Load lists from any curator below, then select only the lists you want to include.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="curator-list-sort" className="text-sm font-medium">Sort curator lists by</Label>
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
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {trustedCurators.map((curator) => (
                  <Button
                    key={curator.username}
                    type="button"
                    variant="outline"
                    className="h-auto min-w-0 items-start justify-start whitespace-normal p-3 text-left"
                    disabled={isLoadingCuratorLists}
                    onClick={() => {
                      void loadCuratorLists(curator);
                    }}
                  >
                    <div className="min-w-0 w-full space-y-1">
                      <div className="flex items-center gap-2">
                        {isLoadingCuratorLists && loadingCuratorUsername === curator.username ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                        )}
                        <span className="font-medium leading-tight break-words">{curator.name}</span>
                      </div>
                      <p className="text-xs text-muted-foreground break-words">{curator.description}</p>
                    </div>
                  </Button>
                ))}
              </div>
            </div>

            {loadedCuratorLists.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                No curator lists loaded yet. Load a curator to choose specific lists.
              </div>
            ) : (
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">Loaded curator lists</p>
                  <Badge variant="outline" className="text-xs">
                    {selectedCuratorListCount}/{loadedCuratorLists.length} selected
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-background/70 px-3 py-2">
                  <Switch
                    id="select-all-curator-lists"
                    checked={selectedCuratorListCount === loadedCuratorLists.length && loadedCuratorLists.length > 0}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        setSelectedCuratorListKeys(new Set(loadedCuratorLists.map((list) => list.selectionKey)));
                      } else {
                        setSelectedCuratorListKeys(new Set());
                      }
                    }}
                  />
                  <Label htmlFor="select-all-curator-lists" className="cursor-pointer text-sm font-medium">
                    Select all loaded lists
                  </Label>
                </div>

                <div className="grid gap-2 max-h-72 overflow-y-auto rounded-md border border-border/60 bg-background/70 p-2">
                  {loadedCuratorLists.map((list) => {
                    const inputId = `curator-list-${list.selectionKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                    const selected = selectedCuratorListKeys.has(list.selectionKey);
                    return (
                      <div
                        key={list.selectionKey}
                        className={cn(
                          'flex items-start gap-3 rounded-md border border-border/60 bg-background/80 p-3',
                          selected && 'border-primary/60 bg-primary/5'
                        )}
                      >
                        <Switch
                          id={inputId}
                          checked={selected}
                          onCheckedChange={(checked) => handleCuratorListSelection(list.selectionKey, checked)}
                        />
                        <div className="min-w-0 flex-1">
                          <Label htmlFor={inputId} className="cursor-pointer font-medium leading-tight break-words">
                            {list.name}
                          </Label>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="text-xs capitalize">
                              {list.mediatype || 'series'}
                            </Badge>
                            <Badge variant="secondary" className="text-xs">
                              by {list.curatorName}
                            </Badge>
                            {typeof list.items === 'number' && (
                              <Badge variant="secondary" className="text-xs">
                                {list.items} items
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {renderStepActions()}
          </CardContent>
        </Card>
      )}

      <Card className="border-dashed border-border bg-muted/20">
        <CardContent className="p-4 md:p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">Wizard summary</p>
            <Badge variant="outline" className="text-xs">
              {selectedPreset ? 'Configured' : 'Needs preset'}
            </Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Preset</p>
              <p className="text-sm font-medium text-foreground truncate">{selectedPreset ? selectedPreset.name : 'Not selected'}</p>
            </div>
            {hasReachedSafetyStep && (
              <>
                <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Safe viewing</p>
                  <p className="text-sm font-medium text-foreground">{includeAdult ? 'NSFW' : 'SFW'}</p>
                </div>
                <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Display labels</p>
                  <p className="text-sm font-medium text-foreground truncate">{displayTypeSummary || 'No overrides'}</p>
                </div>
              </>
            )}
            {hasReachedKeysStep && (
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Required keys</p>
                <p className="text-sm font-medium text-foreground">
                  {requiredPresetKeys.length === 0
                    ? 'None'
                    : requiredKeysSatisfied
                      ? 'Added'
                      : `Missing (${missingRequiredKeys.length})`}
                </p>
              </div>
            )}
            {hasReachedStreamingStep && (
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 sm:col-span-2">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Streaming services</p>
                <p className="text-sm font-medium text-foreground truncate">
                  {selectedStreamingProviderNames || 'Skipped'}
                </p>
              </div>
            )}
            {hasReachedCuratorsStep && (
              <div className="rounded-md border border-border/60 bg-background/80 px-3 py-2 sm:col-span-2 lg:col-span-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Curator import</p>
                <p className="text-sm font-medium text-foreground truncate">
                  {selectedCuratorListCount > 0
                    ? `${selectedCuratorListCount} selected from ${selectedCuratorNames || 'featured curators'}`
                    : 'Skipped'}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={showBackupDialog} onOpenChange={setShowBackupDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Backup current configuration?</DialogTitle>
            <DialogDescription>
              Applying a preset will overwrite your configuration, would you like a backup?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={handleCancelApply} disabled={isApplyingWizard || isExportingBackup}>
              Cancel
            </Button>
            <Button onClick={handleApplyWithBackup} disabled={isApplyingWizard || isExportingBackup}>
              Yes
            </Button>
            <Button variant="outline" onClick={handleApplyWithoutBackup} disabled={isApplyingWizard || isExportingBackup}>
              No
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showApplySuccessDialog} onOpenChange={setShowApplySuccessDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              Success!
            </DialogTitle>
            <DialogDescription>
              Preset applied successfully. Choose where you want to go next.
            </DialogDescription>
          </DialogHeader>
          {applySuccessSummary && (
            <p className="text-sm text-muted-foreground">
              {applySuccessSummary}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            Open Configuration to save your changes to the database.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowApplySuccessDialog(false)}
            >
              Stay here
            </Button>
            <Button
              variant="outline"
              onClick={() => navigateToSettingsTab('catalogs')}
            >
              Go to Catalogs
            </Button>
            <Button
              onClick={() => navigateToSettingsTab('configuration')}
            >
              Go to Configuration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
