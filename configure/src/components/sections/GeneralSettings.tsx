import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { WatchTrackingOptionsDialog } from '@/components/WatchTrackingOptionsDialog';
import { useConfig } from '@/contexts/ConfigContext';
import type { WatchTrackingService } from '@/contexts/config';
import { navigateToSettingsSection } from '@/lib/settingsRoute';
import {
  getWatchTrackingMediaTypeSummary,
  WATCH_TRACKING_SERVICE_DEFINITIONS,
} from '@/lib/watchTracking';

import { languageOptions } from '@/data/languages';

const castCountOptions = [
    { value: 0, label: '0 Members' },
    { value: 5, label: '5 Members' },
    { value: 10, label: '10 Members' },
    { value: 15, label: '15 Members' },
    { value: -1, label: 'Unlimited' } 
];

// Common timezones for the selector
const timezoneOptions = [
  { value: 'UTC', label: 'UTC (GMT+0)' },
  { value: 'America/New_York', label: 'Eastern Time (US & Canada)' },
  { value: 'America/Chicago', label: 'Central Time (US & Canada)' },
  { value: 'America/Denver', label: 'Mountain Time (US & Canada)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US & Canada)' },
  { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
  { value: 'America/Phoenix', label: 'Arizona' },
  { value: 'America/Toronto', label: 'Toronto' },
  { value: 'America/Mexico_City', label: 'Mexico City' },
  { value: 'America/Sao_Paulo', label: 'Brasília' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Dublin', label: 'Dublin' },
  { value: 'Europe/Lisbon', label: 'Lisbon' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Europe/Rome', label: 'Rome' },
  { value: 'Europe/Madrid', label: 'Madrid' },
  { value: 'Europe/Amsterdam', label: 'Amsterdam' },
  { value: 'Europe/Brussels', label: 'Brussels' },
  { value: 'Europe/Stockholm', label: 'Stockholm' },
  { value: 'Europe/Warsaw', label: 'Warsaw' },
  { value: 'Europe/Zurich', label: 'Zurich' },
  { value: 'Europe/Vienna', label: 'Vienna' },
  { value: 'Europe/Prague', label: 'Prague' },
  { value: 'Europe/Budapest', label: 'Budapest' },
  { value: 'Europe/Copenhagen', label: 'Copenhagen' },
  { value: 'Europe/Oslo', label: 'Oslo' },
  { value: 'Africa/Johannesburg', label: 'Johannesburg' },
  { value: 'Europe/Athens', label: 'Athens' },
  { value: 'Europe/Helsinki', label: 'Helsinki' },
  { value: 'Europe/Bucharest', label: 'Bucharest' },
  { value: 'Africa/Cairo', label: 'Cairo' },
  { value: 'Asia/Jerusalem', label: 'Jerusalem' },
  { value: 'Europe/Istanbul', label: 'Istanbul' },
  { value: 'Europe/Moscow', label: 'Moscow' },
  { value: 'Asia/Dubai', label: 'Dubai' },
  { value: 'Asia/Kolkata', label: 'India' },
  { value: 'Asia/Bangkok', label: 'Bangkok' },
  { value: 'Asia/Jakarta', label: 'Jakarta' },
  { value: 'Asia/Ho_Chi_Minh', label: 'Ho Chi Minh City' },
  { value: 'Asia/Shanghai', label: 'Beijing/Shanghai' },
  { value: 'Asia/Hong_Kong', label: 'Hong Kong' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Asia/Manila', label: 'Manila' },
  { value: 'Asia/Taipei', label: 'Taipei' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Seoul', label: 'Seoul' },
  { value: 'Australia/Sydney', label: 'Sydney' },
  { value: 'Australia/Melbourne', label: 'Melbourne' },
  { value: 'Australia/Brisbane', label: 'Brisbane' },
  { value: 'Australia/Perth', label: 'Perth' },
  { value: 'Pacific/Auckland', label: 'Auckland' },
];

export function GeneralSettings() {
  // Use our custom hook to get the current config and the function to update it
  const { config, setConfig } = useConfig();
  const [watchTrackingService, setWatchTrackingService] = useState<WatchTrackingService | null>(null);
  const [connectPrompt, setConnectPrompt] = useState<WatchTrackingService | null>(null);

  // --- Handler Functions ---
  // These functions update the single state object, preserving the other values.

  const handleLanguageChange = (value: string) => {
    setConfig(prevConfig => ({ ...prevConfig, language: value }));
  };

  const handleIncludeAdultChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, includeAdult: checked }));
  };

  const handleBlurThumbsChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, blurThumbs: checked }));
  };

  const handleShowPrefixChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, showPrefix: checked }));
  };

  const handleDisplayTypeOverrideChange = (kind: 'movie' | 'series', value: string) => {
    setConfig(prevConfig => {
      const next = { ...(prevConfig.displayTypeOverrides || {}), [kind]: value.trim() || undefined };
      const hasAny = !!(next.movie || next.series);
      return { ...prevConfig, displayTypeOverrides: hasAny ? next : undefined };
    });
  };

  const handleShowMetaProviderAttributionChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, showMetaProviderAttribution: checked }));
  };

  const handleCastCountChange = (value: string) => {
    const count = parseInt(value, 10);
    setConfig(prevConfig => ({ ...prevConfig, castCount: count === -1 ? undefined : count }));
  };

  const handleDisplayAgeRatingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, displayAgeRating: checked }));
  };

  const handleMDBListTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, mdblistWatchTracking: checked }));
  };

  const handleAniListTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, anilistWatchTracking: checked }));
  };

  const handleMalTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, malWatchTracking: checked }));
  };
  
  const handleSimklTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, simklWatchTracking: checked }));
  };

  const handleTraktTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, traktWatchTracking: checked }));
  };

  const handlePublicMetaDBTrackingChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, publicmetadbWatchTracking: checked }));
  };

  const handleEnableRatingPostersForLibraryChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, enableRatingPostersForLibrary: checked }));
  };

  const handleShowRateMeButtonChange = (checked: boolean) => {
    setConfig(prevConfig => ({ ...prevConfig, showRateMeButton: checked }));
  };

  const handleTimezoneChange = (value: string) => {
    setConfig(prevConfig => ({ ...prevConfig, timezone: value }));
  };

  const renderWatchTrackingControls = (
    service: WatchTrackingService,
    switchId: string,
    checked: boolean,
    onCheckedChange: (checked: boolean) => void,
  ) => {
    const handleToggle = (next: boolean) => {
      onCheckedChange(next);
      if (next && !WATCH_TRACKING_SERVICE_DEFINITIONS[service].hasCredential(config)) {
        setConnectPrompt(service);
      }
    };

    return (
    <div className="flex items-center gap-1 shrink-0">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-9 w-9"
        aria-label={`Configure ${WATCH_TRACKING_SERVICE_DEFINITIONS[service].label} watch tracking types`}
        title="Configure media types"
        onClick={() => setWatchTrackingService(service)}
      >
        <Settings2 className="h-4 w-4 text-muted-foreground" />
      </Button>
      <Switch id={switchId} checked={checked} onCheckedChange={handleToggle} />
    </div>
    );
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">General</h2>
        <p className="text-muted-foreground mt-1">Configure the basic display and content settings for your addon.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Display & Language</CardTitle>
            <CardDescription>Control how content is presented in your addon.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="language" className="font-medium">Display Language</Label>
                <p className="text-sm text-muted-foreground">Language for titles and descriptions.</p>
              </div>
              <Select value={config.language} onValueChange={handleLanguageChange}>
                <SelectTrigger id="language" className="w-full sm:w-[200px] shrink-0">
                  <SelectValue placeholder="Select language" />
                </SelectTrigger>
                <SelectContent>
                  {languageOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="timezone" className="font-medium">Timezone</Label>
                <p className="text-sm text-muted-foreground">For calendar-based features (e.g., Trakt Calendar).</p>
              </div>
              <Select value={config.timezone || 'UTC'} onValueChange={handleTimezoneChange}>
                <SelectTrigger id="timezone" className="w-full sm:w-[240px] shrink-0">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent>
                  {timezoneOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="cast-count" className="font-medium">Cast Members</Label>
                <p className="text-sm text-muted-foreground">Number of cast members on details page.</p>
              </div>
              <Select value={String(config.castCount ?? -1)} onValueChange={handleCastCountChange}>
                <SelectTrigger id="cast-count" className="w-full sm:w-[160px] shrink-0">
                  <SelectValue placeholder="Select count" />
                </SelectTrigger>
                <SelectContent>
                  {castCountOptions.map(opt => (
                    <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="show-prefix" className="font-medium">Show Prefix</Label>
                <p className="text-sm text-muted-foreground">Add "{config.addonName || 'AIOMetadata'} - " prefix to catalogs.</p>
              </div>
              <Switch id="show-prefix" checked={config.showPrefix} onCheckedChange={handleShowPrefixChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="show-meta-provider-attribution" className="font-medium">Meta Attribution</Label>
                <p className="text-sm text-muted-foreground">Show "[Meta provided by Provider]" in overview.</p>
              </div>
              <Switch id="show-meta-provider-attribution" checked={config.showMetaProviderAttribution} onCheckedChange={handleShowMetaProviderAttributionChange} />
            </div>

            <div className="space-y-3 p-3 rounded-lg">
              <div>
                <Label className="font-medium">Catalog Type Labels</Label>
                <p className="text-sm text-muted-foreground">
                  Clients label rows by content type, as in "Netflix - Series". Override the wording
                  to taste, for example "Netflix - Shows". Leave blank to keep the default.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {(['movie', 'series'] as const).map(kind => (
                  <div key={kind} className="space-y-1.5">
                    <Label htmlFor={`display-type-${kind}`} className="text-sm">
                      {kind === 'movie' ? 'Movies' : 'Series'}
                    </Label>
                    <Input
                      id={`display-type-${kind}`}
                      value={config.displayTypeOverrides?.[kind] || ''}
                      placeholder={kind === 'movie' ? 'e.g. film' : 'e.g. shows'}
                      onChange={event => handleDisplayTypeOverrideChange(kind, event.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="display-age-rating" className="font-medium">Display Age Rating</Label>
                <p className="text-sm text-muted-foreground">Show rating/certification in genres.</p>
              </div>
              <Switch id="display-age-rating" checked={config.displayAgeRating} onCheckedChange={handleDisplayAgeRatingChange} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Content & Privacy</CardTitle>
            <CardDescription>Manage adult content, spoilers, and poster settings.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="adult-content" className="font-medium">Include Adult Content</Label>
                <p className="text-sm text-muted-foreground">Show NSFW content in catalogs and search.</p>
              </div>
              <Switch id="adult-content" checked={config.includeAdult} onCheckedChange={handleIncludeAdultChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="blur-thumbs" className="font-medium">Hide Episode Spoilers</Label>
                <p className="text-sm text-muted-foreground">Blur episode thumbnails to avoid spoilers.</p>
              </div>
              <Switch id="blur-thumbs" checked={config.blurThumbs} onCheckedChange={handleBlurThumbsChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="show-rate-me-button" className="font-medium">Show Rate Me Button</Label>
                <p className="text-sm text-muted-foreground">Display a rating button in meta pages.</p>
              </div>
              <Switch id="show-rate-me-button" checked={!!config.showRateMeButton} onCheckedChange={handleShowRateMeButtonChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="enable-rating-posters-for-library" className="font-medium">Rating Posters for Library</Label>
                <p className="text-sm text-muted-foreground">Keep rating posters for Continue Watching and Library items.</p>
              </div>
              <Switch id="enable-rating-posters-for-library" checked={config.enableRatingPostersForLibrary !== false} onCheckedChange={handleEnableRatingPostersForLibraryChange} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Watch Tracking</CardTitle>
          <CardDescription>Record what you watch to the services you have connected below.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="min-w-[12rem] flex-1">
                <div className="flex items-center gap-2">
                  <Label htmlFor="playback-detection" className="font-medium">When to record</Label>
                  {config.playbackReporting ? (
                    <Badge variant="outline" className="text-[10px] border-amber-400/60 text-amber-400">Jellyfin only</Badge>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  Applies to every service below.
                </p>
              </div>
              <Select
                value={config.playbackReporting ? 'reported' : 'opened'}
                onValueChange={(v) => setConfig(prev => ({ ...prev, playbackReporting: v === 'reported' }))}
              >
                <SelectTrigger id="playback-detection" className="w-full sm:w-[260px] shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="opened">
                    <span className="flex items-center gap-2">
                      When a title is opened
                      <Badge variant="secondary" className="text-[10px]">Any client</Badge>
                    </span>
                  </SelectItem>
                  <SelectItem value="reported">
                    <span className="flex items-center gap-2">
                      When playback starts and stops
                      <Badge variant="secondary" className="text-[10px]">Jellyfin only</Badge>
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {config.playbackReporting ? (
              <p className="text-xs text-muted-foreground">
                Only a client that reports playback can drive this, which today means Jellyfin ones. In exchange, something you abandon after a few minutes is kept as a resume point rather than being marked watched, and a client that asks can read back what your trackers hold, so its Continue Watching reflects other devices. <span className="text-amber-400">Watching anywhere else, Stremio included, records nothing at all.</span>
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Recorded as soon as you open a title, which is the only signal most clients give. Simple and works everywhere, but anything you open counts as watched even if you stop a minute in.
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="trakt-watch-tracking" className="font-medium">Trakt</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'trakt')}</p>
              </div>
              {renderWatchTrackingControls('trakt', 'trakt-watch-tracking', !!config.traktWatchTracking, handleTraktTrackingChange)}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="simkl-watch-tracking" className="font-medium">Simkl</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'simkl')}</p>
              </div>
              {renderWatchTrackingControls('simkl', 'simkl-watch-tracking', !!config.simklWatchTracking, handleSimklTrackingChange)}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="anilist-watch-tracking" className="font-medium">AniList</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'anilist')}</p>
              </div>
              {renderWatchTrackingControls('anilist', 'anilist-watch-tracking', !!config.anilistWatchTracking, handleAniListTrackingChange)}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="mal-watch-tracking" className="font-medium">MyAnimeList</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'mal')}</p>
              </div>
              {renderWatchTrackingControls('mal', 'mal-watch-tracking', !!config.malWatchTracking, handleMalTrackingChange)}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="mdblist-watch-tracking" className="font-medium">MDBList</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'mdblist')}</p>
              </div>
              {renderWatchTrackingControls('mdblist', 'mdblist-watch-tracking', !!config.mdblistWatchTracking, handleMDBListTrackingChange)}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 rounded-lg hover:bg-accent/50 transition-colors">
              <div className="min-w-[12rem] flex-1">
                <Label htmlFor="publicmetadb-watch-tracking" className="font-medium">PublicMetaDB</Label>
                <p className="text-sm text-muted-foreground">{getWatchTrackingMediaTypeSummary(config, 'publicmetadb')}</p>
              </div>
              {renderWatchTrackingControls('publicmetadb', 'publicmetadb-watch-tracking', !!config.publicmetadbWatchTracking, handlePublicMetaDBTrackingChange)}
            </div>
          </div>
        </CardContent>
      </Card>

      <WatchTrackingOptionsDialog
        service={watchTrackingService}
        open={watchTrackingService !== null}
        onOpenChange={(open) => {
          if (!open) setWatchTrackingService(null);
        }}
      />

      <AlertDialog open={connectPrompt !== null} onOpenChange={(open) => { if (!open) setConnectPrompt(null); }}>
        <AlertDialogContent>
          {connectPrompt && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Connect {WATCH_TRACKING_SERVICE_DEFINITIONS[connectPrompt].label} to start tracking
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {WATCH_TRACKING_SERVICE_DEFINITIONS[connectPrompt].connectHint} The setting is on and will
                  start working as soon as the account is connected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Later</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const { connectSection } = WATCH_TRACKING_SERVICE_DEFINITIONS[connectPrompt];
                    setConnectPrompt(null);
                    navigateToSettingsSection(connectSection);
                  }}
                >
                  Take me there
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
