import type { ReactNode } from 'react';
import { Puzzle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Reporting, Step } from '@/components/settings/StepTimeline';
import { Segmented } from '@/components/settings/Segmented';
import { useConfig } from '@/contexts/ConfigContext';
import type { WatchTrackingService } from '@/contexts/config';
import { useStremioLinkStatus } from '@/hooks/useStremioLinkStatus';
import { CARD_SERVICES, isHolder } from '@/lib/cardAccounts';
import { navigateToSettingsSection } from '@/lib/settingsRoute';
import { cn } from '@/lib/utils';
import {
  openServiceConnect,
  isWatchTrackingMediaTypeSelected,
  scrobblesJellyfin,
  scrobblesStremio,
  stremioLinkState,
  WATCH_TRACKING_SERVICE_DEFINITIONS,
  WATCH_TRACKING_SERVICES,
  withStremioEventsSince,
  type WatchTrackingMediaType,
} from '@/lib/watchTracking';

function ago(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function SourceCard({ id, icon, title, hint, checked, onChange, children }: {
  id: string;
  icon: ReactNode;
  title: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-3.5 rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40" aria-hidden="true">{icon}</div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label htmlFor={id} className="font-medium">{title}</Label>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        <Switch id={id} checked={checked} onCheckedChange={onChange} className="shrink-0" />
      </div>
      {children}
    </div>
  );
}


export function WatchTrackingSettings() {
  const { config, setConfig } = useConfig();
  const finished = config.playbackReporting === true;
  const stremioOn = scrobblesStremio(config);
  const jellyfinOn = scrobblesJellyfin(config);
  const linkStatus = useStremioLinkStatus(stremioOn);

  // Any install that has reported counts; the newest report is the one shown.
  const links = Object.values(linkStatus ?? {});
  const states = links.map((link) => stremioLinkState(config.stremioScrobblingSince, link));
  const lastReport = Math.max(0, ...links.map((link) => (link.eventAt && link.eventAt >= (config.stremioScrobblingSince ?? 0) ? link.eventAt : 0)));
  const addonStatus = !linkStatus
    ? null
    : states.includes('ok')
    ? <Reporting tone="ok" text="Reports playback" detail={lastReport ? `Last report ${ago(lastReport)}` : undefined} />
    : states.includes('waiting')
      ? <Reporting tone="wait" text="Installed, waiting for its first report" />
      : <Reporting tone="wait" text="Install the addon again so it can report playback" />;

  const connected = WATCH_TRACKING_SERVICES.filter((service) => WATCH_TRACKING_SERVICE_DEFINITIONS[service].hasCredential(config));
  const unconnected = WATCH_TRACKING_SERVICES.filter((service) => !connected.includes(service));

  // Both read as off while a title counts when opened. Turning one on moves step 2 to finished with only that
  // one on. Turning the last one off leaves step 2 at finished, so nothing is recorded rather than every title opened.
  const setSource = (source: 'jellyfinScrobbling' | 'stremioScrobbling', on: boolean) => {
    setConfig((prev) => {
      if (prev.playbackReporting !== true) {
        return on ? withStremioEventsSince(prev, { ...prev, playbackReporting: true, jellyfinScrobbling: false, stremioScrobbling: false, [source]: true }) : prev;
      }
      return withStremioEventsSince(prev, { ...prev, [source]: on });
    });
  };

  const setMediaType = (service: WatchTrackingService, mediaType: WatchTrackingMediaType, on: boolean) => {
    setConfig((prev) => ({
      ...prev,
      watchTracking: { ...prev.watchTracking, [service]: { ...prev.watchTracking?.[service], [mediaType]: on } },
    }));
  };

  const others = (config.jellyfinUsers ?? []).some((user) => isHolder(user));

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Watch Tracking</h2>
        <p className="text-muted-foreground mt-1">Follow a watch from your app to your trackers.</p>
      </div>

      <div>
        <Step n={1} title="You watch on" hint="These apps report playback as you watch: when you start, pause, stop and finish.">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <SourceCard
              id="jellyfin-scrobbling"
              icon={<img src="/jellyfin_icon.svg" alt="" className="h-5 w-5 object-contain" />}
              title="Jellyfin apps"
              hint="Apps signed in to the Jellyfin server here or in AIOStreams"
              checked={jellyfinOn}
              onChange={(on) => setSource('jellyfinScrobbling', on)}
            >
              {jellyfinOn ? <Reporting tone="ok" text="Reports playback" /> : null}
            </SourceCard>
            <SourceCard
              id="stremio-scrobbling"
              icon={<Puzzle className="h-4 w-4 text-muted-foreground" />}
              title="Addon apps"
              hint="Apps that report playback through the addon"
              checked={stremioOn}
              onChange={(on) => setSource('stremioScrobbling', on)}
            >
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                Works with
                <img src="/stremio_icon.png" alt="" className="h-4 w-4 object-contain" />
                <span className="text-foreground/80">Stremio</span>
              </p>
              {stremioOn ? (
                <>
                  {addonStatus}
                  <div className="flex items-center gap-3 border-t pt-3">
                    <Label htmlFor="stremio-library-watchlist" className="flex-1 text-sm font-normal text-foreground/80">Keep the app's library in step with your watchlists</Label>
                    <Switch
                      id="stremio-library-watchlist"
                      checked={config.stremioLibraryWatchlist === true}
                      onCheckedChange={(on) => setConfig((prev) => ({ ...prev, stremioLibraryWatchlist: on }))}
                    />
                  </div>
                </>
              ) : null}
            </SourceCard>
          </div>
          <p className={cn('text-sm', finished && !stremioOn && !jellyfinOn ? 'text-amber-400' : 'text-muted-foreground')}>
            {!finished
              ? "Turn one on to count a title once it's finished."
              : !stremioOn && !jellyfinOn
                ? 'Both are off, so nothing will be recorded.'
                : "Using an app that isn't listed? Step 2 can count a title as watched as soon as it's opened."}
          </p>
        </Step>

        <Step n={2} title="It counts as watched" hint="Opened suits apps that don't report playback. Finished waits for each person's Watched after point.">
          <Segmented
            id="playback-detection"
            label="When a title counts as watched"
            value={finished}
            options={[[false, "When it's opened"], [true, "When it's finished"]]}
            onChange={(value) => setConfig((prev) => (value ? withStremioEventsSince(prev, { ...prev, playbackReporting: true }) : { ...prev, playbackReporting: false }))}
          />
        </Step>

        <Step n={3} last title="And it's sent to" hint={connected.length ? 'Tap a type to leave it out.' : 'Connect a service to send your watches somewhere.'}>
          {connected.length ? (
            <div id="wt-services" className="divide-y overflow-hidden rounded-lg border bg-card">
              {connected.map((service) => {
                const definition = WATCH_TRACKING_SERVICE_DEFINITIONS[service];
                const on = config[definition.masterKey] === true;
                const switchId = `${service}-watch-tracking`;
                return (
                  <div key={service} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 px-4 py-3">
                    <img src={CARD_SERVICES[service].icon} alt="" aria-hidden="true" className="h-7 w-7 shrink-0 rounded-md object-contain" />
                    <Label htmlFor={switchId} className={cn('min-w-[7rem] flex-1 font-medium', !on && 'text-muted-foreground')}>{definition.label}</Label>
                    {on ? (
                      <div className="order-last flex w-full gap-1.5 pl-[2.625rem] sm:order-none sm:w-auto sm:pl-0">
                        {(['movie', 'series'] as const).map((mediaType) => {
                          const picked = isWatchTrackingMediaTypeSelected(config, service, mediaType);
                          return (
                            <button
                              key={mediaType}
                              type="button"
                              aria-pressed={picked}
                              onClick={() => setMediaType(service, mediaType, !picked)}
                              className={cn(
                                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                                picked ? 'border-muted-foreground/30 bg-accent text-foreground' : 'border-dashed text-muted-foreground hover:text-foreground',
                              )}
                            >
                              {mediaType === 'movie' ? definition.movieLabel : definition.seriesLabel}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="order-last w-full pl-[2.625rem] text-sm text-muted-foreground sm:order-none sm:w-auto sm:pl-0">Off</span>
                    )}
                    <Switch
                      id={switchId}
                      checked={on}
                      onCheckedChange={(next) => setConfig((prev) => ({ ...prev, [definition.masterKey]: next }))}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
          {unconnected.length ? (
            <p className="text-sm text-muted-foreground">
              Not connected:{' '}
              {unconnected.map((service, index) => (
                <span key={service}>
                  {index ? ', ' : ''}
                  <button
                    id={`${service}-watch-tracking`}
                    type="button"
                    title={WATCH_TRACKING_SERVICE_DEFINITIONS[service].connectHint}
                    onClick={() => openServiceConnect(service)}
                    className="font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {WATCH_TRACKING_SERVICE_DEFINITIONS[service].label}
                  </button>
                </span>
              ))}
              .
            </p>
          ) : null}
          {others ? (
            <p className="text-sm text-muted-foreground">
              These are yours. Anyone else's go to the trackers on their card in{' '}
              <button
                type="button"
                onClick={() => navigateToSettingsSection('people')}
                className="font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
              >
                People
              </button>
              .
            </p>
          ) : null}
        </Step>
      </div>
    </div>
  );
}
