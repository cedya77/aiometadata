import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { Copy, Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SettingRow } from '@/components/settings/SettingRow';
import { Segmented } from '@/components/settings/Segmented';
import { Step } from '@/components/settings/StepTimeline';
import { Face } from '@/components/users/Face';
import { ClientPasswordCard } from '@/components/jellyfin/ClientPasswordCard';
import { OwnPageCard } from '@/components/jellyfin/OwnPageCard';
import { PeopleList } from '@/components/jellyfin/PeopleList';
import { QuickConnectCard } from '@/components/jellyfin/QuickConnectCard';
import { StreamAddonField } from '@/components/jellyfin/StreamAddonField';
import { SkipMarkersCard } from '@/components/jellyfin/SkipMarkersCard';
import { useConfig } from '@/contexts/ConfigContext';
import { useSave } from '@/contexts/SaveContext';
import { jellyfinServerAddress, useJellyfinServer } from '@/hooks/useJellyfinServer';
import { revealSetting } from '@/hooks/useAnchorFocus';
import { householdPeople } from '@/lib/cardAccounts';
import { navigateToSettingsSection } from '@/lib/settingsRoute';
import { scrobblesJellyfin } from '@/lib/watchTracking';
import { cn } from '@/lib/utils';

function jumpTo(anchor: string) {
  const element = document.getElementById(anchor);
  if (element) revealSetting(element);
}

function StatusPill({ ok, text, onClick }: { ok: boolean; text: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent/50"
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-400' : 'bg-amber-400')} aria-hidden="true" />
      <span className={ok ? 'text-foreground/80' : 'text-amber-400'}>{text}</span>
    </button>
  );
}

function DetailRow({ more, description, ...row }: ComponentProps<typeof SettingRow> & { more?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <SettingRow
      {...row}
      description={
        <>
          {description}
          {more ? (
            <>
              {' '}
              <button
                type="button"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setOpen((v) => !v)}
                className="whitespace-nowrap font-medium text-foreground/70 underline decoration-dotted underline-offset-4 hover:text-foreground"
              >
                {open ? 'Less' : 'More'}
              </button>
            </>
          ) : null}
        </>
      }
      note={more && open ? <p id={id} className="max-w-prose text-xs leading-relaxed text-muted-foreground">{more}</p> : undefined}
    />
  );
}

function SwitchRow({ id, label, hint, more, checked, disabled, onChange }: {
  id: string;
  label: string;
  hint: string;
  more?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <DetailRow
      id={id}
      htmlFor={`${id}-switch`}
      className="px-4 py-4"
      label={label}
      description={hint}
      more={more}
      control={<Switch id={`${id}-switch`} checked={checked} disabled={disabled} onCheckedChange={onChange} />}
    />
  );
}

const SERVER_SET = 'Set by this server.';

export function JellyfinSettings() {
  const { config, setConfig, auth } = useConfig();
  const { savedConfig, isDirty, requestSave, isSaving, canSave } = useSave();
  const server = useJellyfinServer();
  const userUUID = savedConfig?.userUUID ?? (auth.authenticated ? auth.userUUID : null) ?? null;
  const address = userUUID ? jellyfinServerAddress(server.baseUrl, userUUID) : '';

  const resolveForced = server.resolveOnOpen === 'always' ? true : server.resolveOnOpen === 'never' ? false : null;
  const upcomingForced = server.upcomingMode === 'caught-up' || server.upcomingMode === 'airing' ? server.upcomingMode : null;

  const people = householdPeople(config, userUUID ?? '');
  const reporting = scrobblesJellyfin(config);

  const copyAddress = () => {
    void navigator.clipboard.writeText(address)
      .then(() => toast.success('Server address copied to clipboard!'))
      .catch(() => toast.error('Failed to copy to clipboard'));
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold">Jellyfin</h2>
        <p className="text-muted-foreground mt-1">Connect Jellyfin apps to this configuration and choose how they play and browse.</p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2.5">
          <StatusPill ok={Boolean(config.jellyfinStreamUrl?.trim())} text={config.jellyfinStreamUrl?.trim() ? 'Stream addon set' : 'No stream addon'} onClick={() => jumpTo('stream-addon')} />
          <StatusPill ok={Boolean(config.jellyfinAppPassword)} text={config.jellyfinAppPassword ? 'Client password set' : 'No client password'} onClick={() => jumpTo('client-password')} />
          <StatusPill ok={reporting} text={reporting ? 'Reports playback' : 'Not reporting playback'} onClick={() => navigateToSettingsSection('watch-tracking', 'jellyfin-scrobbling')} />
          <button
            type="button"
            onClick={() => jumpTo('jellyfin-people')}
            aria-label={`${people.length} ${people.length === 1 ? 'person' : 'people'}`}
            className="ml-auto flex items-center gap-2 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs text-foreground/80 transition-colors hover:bg-accent/50"
          >
            <span className="flex" aria-hidden="true">
              {people.slice(0, 3).map((person, index) => (
                <Face key={person.key} name={person.name} avatar={person.avatar} className={cn('h-6 w-6 text-[10px]', index ? '-ml-1.5' : undefined)} />
              ))}
            </span>
            {people.length}
          </button>
        </div>
        {isDirty ? <p className="text-xs text-amber-400">Unsaved changes. Jellyfin apps see users, passwords and settings only once saved.</p> : null}
        {userUUID ? <OwnPageCard userUUID={userUUID} /> : null}
      </div>

      <div>
        <Step n={1} title="Add the server" hint="Add this address as a server in your Jellyfin app.">
          {userUUID ? (
            <div className="flex items-center gap-2">
              <Input id="server-address" value={address} readOnly aria-label="Jellyfin server address" className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button variant="outline" className="shrink-0 gap-1.5" onClick={copyAddress}><Copy className="h-4 w-4" /> Copy</Button>
            </div>
          ) : (
            <div id="server-address" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4">
              <p className="text-sm text-muted-foreground">Save the configuration first to get your server address.</p>
              <Button size="sm" disabled={!canSave || isSaving} onClick={requestSave}>
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                Save
              </Button>
            </div>
          )}
        </Step>

        <fieldset disabled={!userUUID} className={cn('min-w-0', !userUUID && 'pointer-events-none opacity-50')}>
          <Step
            n={2}
            title="Sign in"
            hint={!userUUID ? 'Signing in needs a saved configuration, so save it first.' : people.length > 1 ? "Pick who the app is for, then use either method." : 'Use either method.'}
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <QuickConnectCard userUUID={userUUID ?? ''} />
              <ClientPasswordCard />
            </div>
          </Step>
        </fieldset>

        <Step n={3} title="Make titles play" hint="Set for everyone. A person can have their own in People.">
          <div className="divide-y overflow-hidden rounded-lg border bg-card">
            <div className="px-4 py-4">
              <StreamAddonField
                id="stream-addon"
                label="Stream addon for everyone"
                value={config.jellyfinStreamUrl ?? ''}
                onChange={(next) => setConfig((prev) => ({ ...prev, jellyfinStreamUrl: next }))}
                emptyWarning="No stream addon, so Jellyfin apps can browse but not play."
                hint="Paste its install URL, such as your AIOStreams."
              />
            </div>
            <SkipMarkersCard />
            <SwitchRow
              id="resolve-on-open"
              label="Wait for streams when a title opens"
              hint={resolveForced === null ? 'Loads a title\'s versions as soon as it opens, so the picker is ready.' : SERVER_SET}
              more={resolveForced === null ? 'Off, a title opens at once and its versions load when the picker opens or play is pressed, the lightest on your stream addon. On, a title still opens at once while its streams load alongside, and the app gets the versions as soon as it asks again or opens the picker, usually with no wait. An app that asks for the versions with the title gets them either way.' : undefined}
              checked={resolveForced ?? config.jellyfinResolveOnOpen ?? false}
              disabled={resolveForced !== null}
              onChange={(next) => setConfig((prev) => ({ ...prev, jellyfinResolveOnOpen: next ? true : undefined }))}
            />
            <SwitchRow
              id="match-releases"
              label="Match releases in SyncPlay groups"
              hint="Lists the release others in the group are playing first."
              more="On by default. In a SyncPlay group, the release another member is playing is listed first when your stream addon offers it, which helps everyone play the same file. Turn off to keep your stream addon's order."
              checked={config.jellyfinMatchReleases !== false}
              onChange={(next) => setConfig((prev) => ({ ...prev, jellyfinMatchReleases: next ? undefined : false }))}
            />
          </div>
        </Step>

        <Step n={4} last title="Shape what everyone browses" hint="How catalogs, episodes and suggestions show in the apps.">
          <div className="divide-y overflow-hidden rounded-lg border bg-card">
            <SwitchRow
              id="latest-rows"
              label="Latest row per catalog"
              hint="A row of each catalog's first page on the home screen. Off speeds up home but empties it on some apps."
              more="On by default. A client asks each catalog for its newest titles to fill a row per catalog on the home screen, which is one catalog read each and slow to draw when many are enabled. There is no date a title entered a catalog here, so the row is its first page rather than what is new. Some clients build their whole home screen from these rows, so off leaves them empty."
              checked={config.jellyfinLatestRows !== false}
              onChange={(next) => setConfig((prev) => ({ ...prev, jellyfinLatestRows: next ? undefined : false }))}
            />
            <SwitchRow
              id="mark-unaired"
              label="Mark unaired episodes"
              hint="Shows episodes that haven't aired as upcoming instead of playable."
              more="On by default. Episodes that have not aired yet are sent as missing, so apps that support it show them as upcoming and do not offer to play them. Turn off to keep them playable, for when a stream addon has an episode early."
              checked={config.jellyfinMarkUnaired !== false}
              onChange={(next) => setConfig((prev) => ({ ...prev, jellyfinMarkUnaired: next ? undefined : false }))}
            />
            <DetailRow
              id="upcoming-row"
              className="px-4 py-4"
              controlClassName="w-full sm:w-auto"
              label="Upcoming row"
              description={upcomingForced ? SERVER_SET : 'What the Upcoming row lists.'}
              more={upcomingForced ? undefined : "Caught up lists the next episode of the shows you have watched every aired episode of, so a show is in Upcoming or Next Up, never both. Everything airing lists the next episode of every show you follow, behind or not, so a show you are behind on can be in both. Watchlisted films that are not out yet are in it either way."}
              control={
                <Segmented
                  label="Upcoming row"
                  value={upcomingForced ?? config.jellyfinUpcomingMode ?? 'caught-up'}
                  options={[['caught-up', 'Caught up'], ['airing', 'Everything airing']]}
                  disabled={upcomingForced !== null}
                  onChange={(v) => setConfig((prev) => ({ ...prev, jellyfinUpcomingMode: v === 'airing' ? 'airing' : undefined }))}
                />
              }
            />
            <DetailRow
              id="similar-titles"
              className="px-4 py-4"
              controlClassName="w-full sm:w-auto"
              label="Similar titles"
              description={'Where "More Like This" suggestions come from.'}
              more="The titles an app shows as similar on a title's page. TMDB suggests from its own recommendations. Simkl suggests what its users recommend alongside the title, or titles in the same genres when there are none, and uses TMDB for a title it does not know. Also what the More Like This catalog returns to apps that ask for one."
              control={
                <Segmented
                  label="Similar titles"
                  value={config.jellyfinSimilarSource ?? 'tmdb'}
                  options={[['tmdb', 'TMDB'], ['simkl', 'Simkl']]}
                  onChange={(v) => setConfig((prev) => ({ ...prev, jellyfinSimilarSource: v === 'simkl' ? 'simkl' : undefined }))}
                />
              }
            />
          </div>
        </Step>
      </div>

      <PeopleList />
    </div>
  );
}
