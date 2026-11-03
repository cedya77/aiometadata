import { useEffect, useState, type ReactNode } from 'react';
import { Puzzle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { HouseholdUsers } from '@/components/users/HouseholdUsers';
import { useConfig } from '@/contexts/ConfigContext';
import type { WatchTrackingService } from '@/contexts/config';
import { useStremioLinkStatus } from '@/hooks/useStremioLinkStatus';
import { CARD_SERVICES } from '@/lib/cardAccounts';
import { parseRoute } from '@/lib/settingsRoute';
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

const IMAGE_URL = /^https?:\/\//i;

function ago(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function Step({ n, last, title, hint, children }: { n: number; last?: boolean; title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 sm:gap-5">
      <div className="flex w-7 shrink-0 flex-col items-center" aria-hidden="true">
        <div className="flex h-7 w-7 items-center justify-center rounded-full border border-muted-foreground/30 bg-card text-[13px] font-semibold">{n}</div>
        {last ? null : <div className="my-1.5 w-px flex-1 bg-border" />}
      </div>
      <section className={cn('min-w-0 flex-1 space-y-3.5', last ? '' : 'pb-9')}>
        <div className="space-y-0.5 pt-0.5">
          <h3 className="text-[15px] font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        {children}
      </section>
    </div>
  );
}

function Reporting({ tone, text, detail }: { tone: 'ok' | 'wait'; text: string; detail?: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'ok' ? 'bg-emerald-400' : 'bg-amber-400')} aria-hidden="true" />
      <span className="text-foreground/80">{text}</span>
      {detail ? <><span className="text-muted-foreground/50" aria-hidden="true">·</span><span className="text-muted-foreground">{detail}</span></> : null}
    </p>
  );
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

function Face({ name, avatar, first }: { name: string; avatar?: string; first: boolean }) {
  const ring = cn('h-8 w-8 rounded-full border-2 border-background', !first && '-ml-2');
  if (avatar && IMAGE_URL.test(avatar)) return <img src={avatar} alt="" className={cn(ring, 'bg-muted object-cover')} />;
  return (
    <div className={cn(ring, 'flex items-center justify-center bg-muted text-xs font-semibold text-muted-foreground')}>
      {(name.trim()[0] || '?').toUpperCase()}
    </div>
  );
}

const SHOWN_FACES = 4;

export function WatchTrackingSettings() {
  const { config, setConfig } = useConfig();
  const finished = config.playbackReporting === true;
  const stremioOn = scrobblesStremio(config);
  const jellyfinOn = scrobblesJellyfin(config);
  const linkStatus = useStremioLinkStatus(stremioOn);

  const [peopleOpen, setPeopleOpen] = useState(() => parseRoute(window.location.hash).anchor === 'household-users');
  useEffect(() => {
    const follow = () => { if (parseRoute(window.location.hash).anchor === 'household-users') setPeopleOpen(true); };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  // Any install that has reported counts; the newest report is the one shown.
  const links = Object.values(linkStatus ?? {});
  const states = links.map((link) => stremioLinkState(config.stremioScrobblingSince, link));
  const lastReport = Math.max(0, ...links.map((link) => (link.eventAt && link.eventAt >= (config.stremioScrobblingSince ?? 0) ? link.eventAt : 0)));
  const addonStatus = !linkStatus || states.includes('ok')
    ? <Reporting tone="ok" text="Reports playback" detail={lastReport ? `Last report ${ago(lastReport)}` : undefined} />
    : states.includes('waiting')
      ? <Reporting tone="wait" text="Installed, waiting for its first report" />
      : <Reporting tone="wait" text="Install the addon again so it can report playback" />;

  const connected = WATCH_TRACKING_SERVICES.filter((service) => WATCH_TRACKING_SERVICE_DEFINITIONS[service].hasCredential(config));
  const unconnected = WATCH_TRACKING_SERVICES.filter((service) => !connected.includes(service));

  // Both read as off while a title counts when opened. Turning one on moves step 2 to finished with only that
  // one on; turning the last one off moves it back, leaving the switch as it was for the next time.
  const setSource = (source: 'jellyfinScrobbling' | 'stremioScrobbling', on: boolean) => {
    setConfig((prev) => {
      if (prev.playbackReporting !== true) {
        return on ? withStremioEventsSince(prev, { ...prev, playbackReporting: true, jellyfinScrobbling: false, stremioScrobbling: false, [source]: true }) : prev;
      }
      const otherOn = source === 'jellyfinScrobbling' ? scrobblesStremio(prev) : scrobblesJellyfin(prev);
      if (!on && !otherOn) return { ...prev, playbackReporting: false };
      return withStremioEventsSince(prev, { ...prev, [source]: on });
    });
  };

  const setMediaType = (service: WatchTrackingService, mediaType: WatchTrackingMediaType, on: boolean) => {
    setConfig((prev) => ({
      ...prev,
      watchTracking: { ...prev.watchTracking, [service]: { ...prev.watchTracking?.[service], [mediaType]: on } },
    }));
  };

  const mainName = config.jellyfinUserName || config.addonName || 'You';
  const people = [{ name: mainName, avatar: config.jellyfinUserAvatar }, ...(config.jellyfinUsers ?? []).map((u) => ({ name: u.name || 'Unnamed user', avatar: u.avatar }))];

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
              <div className="flex items-center gap-3 rounded-md border bg-background px-3 py-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Works with</span>
                <img src="/stremio_icon.png" alt="Stremio" title="Stremio" className="h-[22px] w-[22px] object-contain" />
              </div>
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

        <Step n={2} title="It counts as watched" hint="For apps that don't report playback, pick when it's opened.">
          <div id="playback-detection" role="radiogroup" aria-label="When a title counts as watched" className="flex gap-1 rounded-lg border bg-card p-1 sm:inline-flex">
            {([
              [false, "When it's opened"],
              [true, "When it's finished"],
            ] as const).map(([value, label]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={finished === value}
                onClick={() => setConfig((prev) => (value ? withStremioEventsSince(prev, { ...prev, playbackReporting: true }) : { ...prev, playbackReporting: false }))}
                className={cn(
                  'flex-1 whitespace-nowrap rounded-md px-2 py-2 text-sm font-medium transition-colors sm:flex-none sm:px-4',
                  finished === value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            ))}
          </div>
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
        </Step>
      </div>

      <div id="household-users" className="space-y-4 border-t pt-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex" aria-hidden="true">
            {people.slice(0, SHOWN_FACES).map((person, index) => <Face key={index} name={person.name} avatar={person.avatar} first={index === 0} />)}
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium">{people.length === 1 ? 'Just you' : `${people.length} people`}</p>
            <p className="text-sm text-muted-foreground">{people.length === 1 ? 'Add the people who watch here, each with their own services' : 'Each one can send to their own services'}</p>
          </div>
          <Button type="button" variant="outline" size="sm" aria-expanded={peopleOpen} onClick={() => setPeopleOpen((open) => !open)}>
            {peopleOpen ? 'Done' : 'Manage people'}
          </Button>
        </div>
        {peopleOpen ? <HouseholdUsers /> : null}
      </div>
    </div>
  );
}
