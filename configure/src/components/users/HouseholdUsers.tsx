import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, Loader2, MoreHorizontal, Plus, User } from 'lucide-react';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { useSave } from '@/contexts/SaveContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
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
import { cn } from '@/lib/utils';
import { TagChip } from '@/components/TagChip';
import { MAX_TAG_NAME_LENGTH, type CatalogConfig, type JellyfinUser, type SkipProvider, type SkipSource, type TagDef } from '@/contexts/config';
import { UserAccounts } from '@/components/jellyfin/UserAccounts';
import { CARD_SERVICES, connectedServices, handoffNameClash, isHolder, pinInvalid, showsAlsoKnownAs, trackerOptionsFor, watchlistOptionsFor } from '@/lib/cardAccounts';
import { disconnectCardAccount } from '@/lib/integrationCredentials';
import { useJellyfinServer } from '@/hooks/useJellyfinServer';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { navigateToSettingsSection } from '@/lib/settingsRoute';
import { scrobblesStremio, WATCH_TRACKING_SERVICE_DEFINITIONS, WATCH_TRACKING_SERVICES } from '@/lib/watchTracking';

const IMAGE_URL = /^https?:\/\//i;

const AVATAR_SIZES = { sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-14 w-14 text-xl' } as const;

function Avatar({ src, name, size = 'md', onClick, title }: { src?: string; name?: string; size?: keyof typeof AVATAR_SIZES; onClick?: () => void; title?: string }) {
  const box = AVATAR_SIZES[size];
  const initial = name?.trim()[0]?.toUpperCase();
  const face = src && IMAGE_URL.test(src)
    ? <img src={src} alt="" className={cn(box, 'rounded-full object-cover bg-muted')} />
    : (
      <div className={cn(box, 'flex items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground')}>
        {initial ?? <User className="h-1/2 w-1/2" />}
      </div>
    );
  if (!onClick) return <div className="shrink-0">{face}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="shrink-0 rounded-full ring-offset-background transition hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {face}
    </button>
  );
}

function HandoffNamesInput({ names, onChange }: { names?: string[]; onChange: (names: string[] | undefined) => void }) {
  const [text, setText] = useState((names ?? []).join(', '));
  useEffect(() => { setText((names ?? []).join(', ')); }, [names]);
  const commit = () => {
    const next = text.split(',').map((n) => n.trim()).filter(Boolean);
    onChange(next.length ? next : undefined);
  };
  return (
    <div>
      <Input
        className="h-8 w-full text-xs"
        aria-label="Also known as"
        placeholder="For example: Mom, mum-aio"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      />
    </div>
  );
}

const SAVED_PIN = /^\$2[aby]\$/;

function PinField({ name, pin, main, onChange }: { name: string; pin?: string; main?: boolean; onChange: (pin: string | undefined) => void }) {
  const [editing, setEditing] = useState(false);
  const saved = Boolean(pin && SAVED_PIN.test(pin));
  const invalid = pinInvalid(pin);
  return (
    <div className="space-y-1.5">
      {saved && !editing ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">PIN set</span>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setEditing(true)}>Change</Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEditing(true); onChange(undefined); }}>Remove</Button>
        </div>
      ) : (
        <Input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={12}
          placeholder={saved ? 'New PIN' : 'No PIN'}
          className="h-8 text-xs"
          aria-label={`PIN of ${name}`}
          autoFocus={editing}
          value={saved ? '' : pin ?? ''}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '') || undefined)}
        />
      )}
      {invalid ? (
        <p className="text-[11px] text-destructive">A PIN is 4 to 12 digits.</p>
      ) : (
        <Note>Sign in on a client with the password, a slash and the PIN, like password/1234. Changing it signs {main ? 'you' : 'this user'} out everywhere.</Note>
      )}
    </div>
  );
}

type PersonTab = 'profile' | 'tracking' | 'catalogs' | 'playback';

interface Person {
  key: string;
  name: string;
  avatar?: string;
  main?: boolean;
  user: JellyfinUser;
  catalogCount: number;
  trackerOptions: Array<{ value: string; label: string; animeOnly?: boolean }>;
  watchlistOptions: WatchlistOption[];
  watchedPoint?: WatchedPoint;
  /** The tracking accounts this person writes to. */
  accounts: string[];
  onChange: (patch: Partial<JellyfinUser>) => void;
  onRemove?: () => void;
  onForget?: () => void;
  /** Their own accounts, for someone else. */
  accountsEditor?: ReactNode;
}

interface PersonDetailProps {
  person: Person;
  allTags: TagDef[];
  hasPmdb: boolean;
  /** The main user's choice, which a user left on "Same as you" follows. */
  mainSkipSource: SkipSource;
  showHandoff?: boolean;
  /** Shows the Jellyfin-only settings, on an instance that runs the Jellyfin server. */
  jellyfin?: boolean;
  /** Stremio SDK scrobbling is on, so each person has an install link in Configuration. */
  stremioOn: boolean;
  tab: PersonTab;
  onTab: (tab: PersonTab) => void;
}

/** One line under a name: who this is, where their watches go and what they see. */
function personSummary(person: Person): string {
  const user = person.user;
  const who = person.main ? 'You' : user.trackers === true ? 'You, on fewer catalogs' : 'Someone else';
  const parts = [who];
  if (person.accounts.length && user.trackers !== true) parts.push(person.accounts.join(', '));
  if (user.tags.length) parts.push(`${person.catalogCount} catalog${person.catalogCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

interface WatchedPoint {
  value: number | null | undefined;
  serverDefault: number;
  onChange: (percent: number | null) => void;
}

function WatchedPointPicker({ name, point }: { name: string; point: WatchedPoint }) {
  const saved = point.value !== undefined;
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const shown = draft ?? point.value ?? point.serverDefault;
  const following = draft === null && point.value == null;

  const slide = (percent: number) => {
    setDraft(percent);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setDraft(null);
      if (percent !== point.value) point.onChange(percent);
    }, 600);
  };

  return (
    <div className="space-y-1.5">
      <div className="text-right text-xs tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">{shown}%</span>
        {following ? ' (server default)' : null}
      </div>
      <input
        id={`watched-${name}`}
        type="range"
        min={50}
        max={100}
        step={1}
        value={shown}
        disabled={!saved}
        aria-label={`Watched point of ${name}`}
        onChange={(e) => slide(Number(e.target.value))}
        className="w-full accent-primary disabled:opacity-50"
      />
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>50%</span>
        {saved && !following ? (
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            onClick={() => { if (timer.current) clearTimeout(timer.current); setDraft(null); point.onChange(null); }}
          >
            Use server default ({point.serverDefault}%)
          </button>
        ) : null}
        <span>100%</span>
      </div>
      {saved ? null : <p className="text-[11px] text-muted-foreground">Save the configuration first, then set when a title counts as watched for this user.</p>}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-muted-foreground">{children}</p>;
}

/** One setting: its name and a line on what it does on the left, the control on the right, details below. */
function SettingRow({ label, description, control, children }: { label: string; description?: string; control?: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-2 py-3 first:pt-1 last:pb-1">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-[12rem] flex-1 space-y-0.5">
          <p className="text-sm font-medium">{label}</p>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
        {control ? <div className="w-full shrink-0 sm:w-64">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** The longer notes under a setting, kept apart from the control. */
function WhoChoice({ selected, title, hint, disabled, onSelect }: { selected: boolean; title: string; hint: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex flex-1 items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        selected ? 'border-foreground/70 bg-accent/40' : 'hover:bg-accent/30',
      )}
    >
      <span className={cn('mt-0.5 h-4 w-4 shrink-0 rounded-full border', selected ? 'border-[5px] border-foreground' : 'border-muted-foreground/50')} aria-hidden="true" />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function PersonDetail({ person, allTags, hasPmdb, mainSkipSource, showHandoff, jellyfin, stremioOn, tab, onTab }: PersonDetailProps) {
  const { name, avatar, main, user, catalogCount, trackerOptions, watchlistOptions, watchedPoint, onChange, onRemove, onForget, accountsEditor } = person;
  const chosen = user.tags ?? [];
  const toggleTag = (tag: string) =>
    onChange({ tags: chosen.includes(tag) ? chosen.filter((t) => t !== tag) : [...chosen, tag] });
  const caps = allTags
    .filter((t) => chosen.includes(t.name) && t.ageRating && t.ageRating !== 'None')
    .map((t) => t.ageRating as string);
  const samePerson = main || user.trackers === true;
  const holder = !main && isHolder(user);
  const [pictureOpen, setPictureOpen] = useState(false);

  // A holder that has lost the service its pick named (e.g. disconnected it) falls back to Automatic.
  const rawTrackerSource = user.trackerSource;
  const trackerKnown = rawTrackerSource === 'auto' || rawTrackerSource === 'off' || trackerOptions.some((opt) => opt.value === rawTrackerSource);
  const trackerValue = holder && rawTrackerSource && !trackerKnown ? 'auto' : rawTrackerSource ?? (main || holder ? 'auto' : 'inherit');

  const canForget = Boolean(onForget) && (main || !samePerson);
  const hasMenu = canForget || Boolean(onRemove);
  const openInstallLink = () => navigateToSettingsSection('configuration', `install-link-${user.id || 'main'}`);
  const tabs: Array<[PersonTab, string]> = [['profile', 'Profile'], ['tracking', 'Tracking'], ['catalogs', 'Catalogs'], ...(jellyfin ? [['playback', 'Playback'] as [PersonTab, string]] : [])];
  const shown = tabs.some(([id]) => id === tab) ? tab : 'profile';

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 pt-5 sm:px-6">
        <Avatar src={avatar} name={name} size="lg" onClick={() => setPictureOpen((v) => !v)} title={`Picture of ${name}`} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold">{name || 'Unnamed user'}</p>
          <p className="truncate text-sm text-muted-foreground">{personSummary(person)}</p>
        </div>
        <div className="flex items-center gap-2">
          {stremioOn ? (
            <Button variant="outline" size="sm" className="gap-1" onClick={openInstallLink}>
              Install link <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {hasMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 w-9 p-0 text-muted-foreground" aria-label={`More for ${name}`}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canForget ? <DropdownMenuItem onSelect={() => onForget?.()}>Forget imported history</DropdownMenuItem> : null}
                {canForget && onRemove ? <DropdownMenuSeparator /> : null}
                {onRemove ? <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onRemove()}>Remove {name || 'this user'}</DropdownMenuItem> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      {pictureOpen || (avatar && !IMAGE_URL.test(avatar)) ? (
        <div className="px-4 pt-3 sm:px-6">
          <Input
            value={avatar ?? ''}
            placeholder="Picture address (https://...)"
            className="h-8 font-mono text-xs"
            aria-label={`Picture of ${name}`}
            autoFocus={pictureOpen}
            onChange={(e) => onChange({ avatar: e.target.value || undefined })}
          />
        </div>
      ) : null}

      <div role="tablist" aria-label={`Settings of ${name}`} className="mt-4 flex gap-6 overflow-x-auto border-b px-4 sm:px-6">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={shown === id}
            onClick={() => onTab(id)}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 py-2.5 text-sm font-medium transition-colors',
              shown === id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="divide-y px-4 py-2 sm:px-6">
        {shown === 'profile' ? (
          <>
            <SettingRow
              label="Name"
              control={
                <Input
                  value={name}
                  maxLength={MAX_TAG_NAME_LENGTH}
                  className="h-8 text-sm"
                  aria-label={main ? 'Name of the main user' : `Name of ${name}`}
                  onChange={(e) => onChange({ name: e.target.value })}
                />
              }
            />
            {main ? (
              <SettingRow label="Who is this" description="You: your history and your trackers." />
            ) : (
              <SettingRow label="Who is this">
                <div role="radiogroup" aria-label={`Who ${name} is`} className="flex flex-col gap-2 sm:flex-row">
                  <WhoChoice
                    selected={samePerson}
                    title="Me, on fewer catalogs"
                    hint="Shares your history and your trackers"
                    disabled={holder}
                    onSelect={() => onChange({ trackers: true })}
                  />
                  <WhoChoice
                    selected={!samePerson}
                    title="Someone else"
                    hint="Their own history, and their own trackers if they connect any"
                    onSelect={() => onChange({ trackers: undefined })}
                  />
                </div>
                {holder ? <Note>Disconnect their trackers first to make this you.</Note> : null}
              </SettingRow>
            )}
            {jellyfin ? (
              <SettingRow
                label="PIN"
                description={main ? 'Asked when someone switches to you.' : `Asked when someone switches to ${name || 'this user'}.`}
                control={<PinField name={name} pin={user.pin} main={main} onChange={(pin) => onChange({ pin })} />}
              />
            ) : null}
            {showHandoff ? (
              <SettingRow label="Also known as" description="Names AIOStreams and other apps use for this person.">
                <HandoffNamesInput names={user.handoffNames} onChange={(handoffNames) => onChange({ handoffNames })} />
              </SettingRow>
            ) : null}
          </>
        ) : null}

        {shown === 'tracking' ? (
          <>
            {main ? (
              <SettingRow label="Trackers" description="Yours are the services in step 3 above." />
            ) : samePerson ? (
              <SettingRow label="Trackers" description="Shares yours." />
            ) : accountsEditor ? (
              <div className="py-3">{accountsEditor}</div>
            ) : null}
            <SettingRow
              label="Continue Watching from"
              description={resumeSourceCaption(trackerValue, trackerOptions)}
              control={
                <Select value={trackerValue} onValueChange={(v) => onChange({ trackerSource: v === 'inherit' ? undefined : (v as JellyfinUser['trackerSource']) })}>
                  <SelectTrigger className="h-8 text-xs" aria-label={`Continue Watching of ${name}`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {!main && !holder && <SelectItem value="inherit">Same as you</SelectItem>}
                    <SelectItem value="auto">Automatic</SelectItem>
                    {trackerOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                    <SelectItem value="off">This server only</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            {watchlistOptions.length > 0 ? (
              <SettingRow label="Watchlist" description="Where a heart in an app goes.">
                <WatchlistPicker value={user.watchlistServices} options={watchlistOptions} onChange={(next) => onChange({ watchlistServices: next })} inheritLabel={main || holder ? 'Every connected shelf' : 'Same as you'} />
              </SettingRow>
            ) : null}
            {watchedPoint ? (
              <SettingRow
                label="Counts as watched at"
                description="Stopping earlier keeps it in Continue Watching. Saves on its own."
                control={<WatchedPointPicker name={name} point={watchedPoint} />}
              />
            ) : null}
          </>
        ) : null}

        {shown === 'catalogs' ? (
          allTags.length > 0 ? (
            <SettingRow label="Catalogs" description="The tags this person sees. None picked shows every catalog.">
              <div className="flex flex-wrap items-center gap-1.5">
                {allTags.map((t) => (
                  <TagChip
                    key={t.name}
                    name={t.name}
                    color={t.color}
                    suffix={t.ageRating && t.ageRating !== 'None' ? <span title={`Content rating ${t.ageRating} and lower`}>{t.ageRating}</span> : undefined}
                    onClick={() => toggleTag(t.name)}
                    pressed={chosen.includes(t.name)}
                    dimmed={chosen.length > 0 && !chosen.includes(t.name)}
                  />
                ))}
              </div>
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {chosen.length === 0 ? 'Every catalog' : `${catalogCount} catalog${catalogCount === 1 ? '' : 's'}`}
                {caps.length ? <span className="rounded-full border border-amber-500/40 px-1.5 text-[11px] text-amber-400">{caps.join(', ')} and lower</span> : null}
              </p>
            </SettingRow>
          ) : (
            <SettingRow label="Catalogs" description="Everyone sees every catalog. Give catalogs tags to show people different ones.">
              <Button variant="outline" size="sm" onClick={() => navigateToSettingsSection('catalogs')}>Open Catalogs</Button>
            </SettingRow>
          )
        ) : null}

        {shown === 'playback' ? (
          <>
            <SettingRow
              label="Stream addon"
              description={main ? "Where titles play from on Jellyfin, such as your AIOStreams. Without one they browse but won't play." : 'An addon this person plays from instead of yours.'}
              control={
                <Input
                  id={main ? 'jellyfin-main-stream-url' : undefined}
                  className="h-8 font-mono text-xs"
                  placeholder={main ? 'https://your-aiostreams/stremio/<config>/manifest.json' : 'Same as you'}
                  aria-label={`Stream addon of ${name}`}
                  value={user.streamUrl ?? ''}
                  onChange={(e) => onChange({ streamUrl: e.target.value.trim() ? e.target.value : undefined })}
                />
              }
            >
              {main && !user.streamUrl ? <p className="text-[11px] text-amber-400">No stream addon set, so Jellyfin apps can browse but not play.</p> : null}
            </SettingRow>
            <SettingRow label="Skip intro and credits" description="Where skip markers come from, asked in this order.">
              <SkipSourcePicker
                value={user.skipSource ?? (main ? 'auto' : undefined)}
                inherited={mainSkipSource}
                main={main}
                hasPmdb={hasPmdb}
                onChange={(skipSource) => onChange({ skipSource })}
              />
            </SettingRow>
          </>
        ) : null}
      </div>
    </div>
  );
}

type WatchlistShelf = 'movies' | 'series' | 'anime';
type WatchlistOption = { value: string; label: string; shelves: WatchlistShelf[] };
const SHELF_LABELS: Record<WatchlistShelf, string> = { movies: 'Movies', series: 'Series', anime: 'Anime' };

const WATCHLIST_NONE = 'none';
const WATCHLIST_SERVER = 'server';

/** A pick is `service:shelf` or `server`; none picked means every shelf of every connected service. */
function WatchlistPicker({ value, options, onChange, inheritLabel }: { value?: string[]; options: WatchlistOption[]; onChange: (next: string[] | undefined) => void; inheritLabel: string }) {
  const server = (value ?? []).some((token) => token === WATCHLIST_NONE || token === WATCHLIST_SERVER);
  const picked = (value ?? []).flatMap((token) => {
    const [service, shelf] = token.split(':');
    const option = options.find((o) => o.value === service);
    if (!option) return [];
    return shelf ? [token] : option.shelves.map((s) => `${service}:${s}`);
  });
  const save = (withServer: boolean, shelves: string[]) => {
    const next = withServer ? [WATCHLIST_SERVER, ...shelves] : shelves;
    onChange(next.length ? next : undefined);
  };
  const following = !server && picked.length === 0;
  const every = options.flatMap((o) => o.shelves.map((s) => `${o.value}:${s}`));
  // While following, every shelf shows as on, so a click turns that one off rather than narrowing to it.
  const toggle = (token: string) => {
    const base = following ? every : picked;
    const next = base.includes(token) ? base.filter((t) => t !== token) : [...base, token];
    if (!server && next.length === every.length) onChange(undefined);
    else save(server, next);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <TagChip name={inheritLabel} onClick={() => onChange(undefined)} pressed={following} dimmed={!following} />
        <TagChip name="Keep a list on this server" onClick={() => save(!server, picked)} pressed={server} dimmed={!server} />
      </div>
      <div className="divide-y rounded-md border">
        {options.map((opt) => (
          <div key={opt.value} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
            <span className="text-xs">{opt.label}</span>
            <div className="flex flex-wrap gap-1.5">
              {opt.shelves.map((shelf) => {
                const token = `${opt.value}:${shelf}`;
                const on = following || picked.includes(token);
                return <TagChip key={token} name={SHELF_LABELS[shelf]} onClick={() => toggle(token)} pressed={on} dimmed={!on} />;
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {following
          ? 'Every shelf of every connected service. Switch a shelf off to leave it out.'
          : server && !picked.length
            ? 'Only the list kept on this server.'
            : server
              ? 'The shelves switched on above, plus the list kept on this server.'
              : 'Only the shelves switched on above.'}
      </p>
    </div>
  );
}

function resumeSourceCaption(value: string, options: Array<{ value: string; label: string; animeOnly?: boolean }>): string {
  if (value === 'inherit') return 'Follows yours.';
  if (value === 'off') return 'Only plays here. Trackers are told about plays but never read.';
  if (value === 'auto') {
    const names = options.filter((o) => !o.animeOnly).map((o) => o.label);
    return names.length ? `Paused titles from ${names.join(' and ')}, merged with plays here.` : 'Plays here, until a tracker that keeps positions is connected.';
  }
  const option = options.find((o) => o.value === value);
  if (option?.animeOnly) return `The ${option.label} anime list plus plays here. It keeps no positions.`;
  return `${option?.label ?? 'That tracker'} plus plays here. Pick one when trackers disagree.`;
}

const SKIP_PROVIDERS: Array<{ value: SkipProvider; label: string; note: string }> = [
  { value: 'publicmetadb', label: 'PublicMetaDB', note: 'Your key' },
  { value: 'aniskip', label: 'AniSkip', note: 'Anime only' },
  { value: 'introdb', label: 'IntroDB', note: 'No key needed' },
];

type SkipRow = { value: SkipProvider; on: boolean };

function skipRows(value: SkipSource, hasPmdb: boolean): SkipRow[] {
  const all = SKIP_PROVIDERS.map((p) => p.value);
  const picked = Array.isArray(value) ? value : value === 'off' ? [] : all.includes(value as SkipProvider) ? [value as SkipProvider] : all;
  const on = [...new Set(picked)].filter((p) => all.includes(p) && (p !== 'publicmetadb' || hasPmdb));
  return [...on.map((v) => ({ value: v, on: true })), ...all.filter((p) => !on.includes(p)).map((v) => ({ value: v, on: false }))];
}

function skipSourceOf(rows: SkipRow[], hasPmdb: boolean): SkipSource {
  const on = rows.filter((r) => r.on).map((r) => r.value);
  if (!on.length) return 'off';
  const auto = SKIP_PROVIDERS.map((p) => p.value).filter((p) => p !== 'publicmetadb' || hasPmdb);
  return on.join() === auto.join() ? 'auto' : on;
}

function skipSourceCaption(rows: SkipRow[]): string {
  const on = rows.filter((r) => r.on).map((r) => SKIP_PROVIDERS.find((p) => p.value === r.value)!.label);
  if (!on.length) return 'Off: no markers are offered, so clients show no skip button.';
  const order = on.length === 1 ? `${on[0]} only` : on.join(', then ');
  return `${order}. Intro, recap and credits are each taken from the first source above that has them. Each lookup sends the title, season and episode to the services asked.`;
}

/** Undefined follows the main user; the main user's undefined is Automatic. */
function SkipSourcePicker({ value, inherited, main, hasPmdb, onChange }: { value?: SkipSource; inherited: SkipSource; main?: boolean; hasPmdb: boolean; onChange: (next: SkipSource | undefined) => void }) {
  const following = value === undefined;
  const rows = skipRows(value ?? inherited, hasPmdb);
  const set = (next: SkipRow[]) => onChange(skipSourceOf(next, hasPmdb));
  const onCount = rows.filter((r) => r.on).length;
  const move = (i: number, by: number) => {
    const next = [...rows];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    set(next);
  };
  const reset = main
    ? <TagChip name="Automatic" onClick={() => onChange('auto')} pressed={value === 'auto'} dimmed={value !== 'auto'} />
    : <TagChip name="Same as you" onClick={() => onChange(undefined)} pressed={following} dimmed={!following} />;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">{reset}</div>
      <div className={cn('divide-y rounded-md border', following && 'opacity-60')}>
        {rows.map((row, i) => {
          const provider = SKIP_PROVIDERS.find((p) => p.value === row.value)!;
          const locked = row.value === 'publicmetadb' && !hasPmdb;
          return (
            <div key={row.value} className="flex items-center gap-2 px-2 py-1">
              <span className="w-4 text-center text-[11px] tabular-nums text-muted-foreground">{row.on ? i + 1 : ''}</span>
              <span className={cn('flex-1 text-xs', !row.on && 'text-muted-foreground')}>
                {provider.label}
                <span className="ml-1.5 text-[11px] text-muted-foreground">{locked ? 'Needs a PublicMetaDB key' : provider.note}</span>
              </span>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={!row.on || i === 0} onClick={() => move(i, -1)} aria-label={`Ask ${provider.label} earlier`}>
                <ChevronUp className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={!row.on || i >= onCount - 1} onClick={() => move(i, 1)} aria-label={`Ask ${provider.label} later`}>
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
              <Switch
                checked={row.on}
                disabled={locked}
                onCheckedChange={(on) => set(rows.map((r) => (r.value === row.value ? { ...r, on } : r)))}
                aria-label={`Use ${provider.label} for skip markers`}
              />
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {following ? 'Same as you: follows the order on your own card. Changing anything here gives this user their own.' : skipSourceCaption(rows)}
      </p>
    </div>
  );
}

function newUserId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}


/** Everyone watching on this configuration, on Stremio profiles and Jellyfin sign-ins alike. */
export function HouseholdUsers() {
  const { config, setConfig, auth } = useConfig();
  const { isSaving } = useSave();
  const jellyfin = useJellyfinServer();
  const userUUID = auth.userUUID ?? '';
  const mainName = config.jellyfinUserName || config.addonName || userUUID.slice(0, 8) || 'You';
  const tags = useMemo(() => config.tags ?? [], [config.tags]);
  const users = useMemo(() => config.jellyfinUsers ?? [], [config.jellyfinUsers]);

  const watchlistOptions = useMemo<WatchlistOption[]>(() => {
    const candidates: Array<WatchlistOption & { ready: boolean }> = [
      { value: 'mdblist', label: 'MDBList', shelves: ['movies', 'series'], ready: Boolean(config.apiKeys?.mdblist) && config.mdblistWatchTracking !== false },
      { value: 'simkl', label: 'Simkl', shelves: ['movies', 'series', 'anime'], ready: Boolean(config.apiKeys?.simklTokenId) && config.simklWatchTracking !== false },
      { value: 'anilist', label: 'AniList', shelves: ['anime'], ready: Boolean(config.apiKeys?.anilistTokenId) && config.anilistWatchTracking !== false },
      { value: 'mal', label: 'MyAnimeList', shelves: ['anime'], ready: Boolean(config.apiKeys?.malTokenId) && config.malWatchTracking !== false },
      { value: 'publicmetadb', label: 'PublicMetaDB', shelves: ['movies', 'series'], ready: Boolean(config.apiKeys?.publicmetadb) && config.publicmetadbWatchTracking !== false },
    ];
    return candidates.filter((c) => c.ready).map(({ value, label, shelves }) => ({ value, label, shelves }));
  }, [config.apiKeys, config.mdblistWatchTracking, config.simklWatchTracking, config.anilistWatchTracking, config.malWatchTracking, config.publicmetadbWatchTracking]);

  // Only services that store a playback position can answer the Continue
  // Watching row, and only when they are connected and tracking is on.
  const resumeSourceOptions = useMemo(() => {
    const candidates: Array<{ value: string; label: string; ready: boolean; animeOnly?: boolean }> = [
      { value: 'mdblist', label: 'MDBList', ready: Boolean(config.apiKeys?.mdblist) && config.mdblistWatchTracking !== false },
      { value: 'simkl', label: 'Simkl', ready: Boolean(config.apiKeys?.simklTokenId) && config.simklWatchTracking !== false },
      { value: 'publicmetadb', label: 'PublicMetaDB', ready: Boolean(config.apiKeys?.publicmetadb) && config.publicmetadbWatchTracking !== false },
      { value: 'anilist', label: 'AniList', ready: Boolean(config.apiKeys?.anilistTokenId) && config.anilistWatchTracking !== false, animeOnly: true },
      { value: 'mal', label: 'MyAnimeList', ready: Boolean(config.apiKeys?.malTokenId) && config.malWatchTracking !== false, animeOnly: true },
    ];
    return candidates.filter((c) => c.ready);
  }, [config.apiKeys, config.mdblistWatchTracking, config.simklWatchTracking, config.publicmetadbWatchTracking, config.anilistWatchTracking, config.malWatchTracking]);

  const [selected, setSelected] = useState('main');
  const [tab, setTab] = useState<PersonTab>('profile');
  const [adding, setAdding] = useState(false);

  const stremioOn = scrobblesStremio(config);
  const mainAccounts = WATCH_TRACKING_SERVICES
    .filter((service) => WATCH_TRACKING_SERVICE_DEFINITIONS[service].hasCredential(config))
    .map((service) => WATCH_TRACKING_SERVICE_DEFINITIONS[service].label);

  const catalogCountFor = (chosen: string[]) => {
    const wanted = new Set(chosen.map((t) => t.toLowerCase()));
    return (config.catalogs ?? []).filter((c) => c.enabled && (c.tags ?? []).some((t) => wanted.has(t.toLowerCase()))).length;
  };

  const [watchedPoints, setWatchedPoints] = useState<{ serverDefault: number; byProfile: Record<string, number | null> } | null>(null);
  useEffect(() => {
    if (!jellyfin.enabled || !userUUID || isSaving) return;
    let cancelled = false;
    fetch(`/api/jellyfin/${encodeURIComponent(userUUID)}/played-thresholds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: auth.password || undefined }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data || !Array.isArray(data.profiles)) return;
        setWatchedPoints({
          serverDefault: Number(data.serverDefault) || 80,
          byProfile: Object.fromEntries(data.profiles.map((p: { profile: string | null; percent: number | null }) => [p.profile ?? '', p.percent ?? null])),
        });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [jellyfin.enabled, isSaving, userUUID, auth.password]);

  const watchedPointFor = (profile: string, name: string): WatchedPoint | undefined => {
    if (!watchedPoints) return undefined;
    return {
      value: profile in watchedPoints.byProfile ? watchedPoints.byProfile[profile] : undefined,
      serverDefault: watchedPoints.serverDefault,
      onChange: async (percent) => {
        const previous = watchedPoints.byProfile[profile];
        setWatchedPoints((prev) => (prev ? { ...prev, byProfile: { ...prev.byProfile, [profile]: percent } } : prev));
        try {
          const response = await fetch(`/api/jellyfin/${encodeURIComponent(userUUID)}/played-threshold`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: auth.password || undefined, profile: profile || undefined, percent }),
          });
          const result = await response.json().catch(() => null);
          if (!response.ok) throw new Error(result?.error || 'Could not save the watched point');
          toast.success(`${name}: ${percent === null ? `server default (${watchedPoints.serverDefault}%)` : `watched at ${percent}%`}`);
        } catch (e) {
          setWatchedPoints((prev) => (prev ? { ...prev, byProfile: { ...prev.byProfile, [profile]: previous } } : prev));
          toast.error(e instanceof Error ? e.message : 'Could not save the watched point');
        }
      },
    };
  };

  const [newUserName, setNewUserName] = useState('');
  const updateUser = (id: string, patch: Partial<JellyfinUser>) =>
    setConfig(prev => ({
      ...prev,
      jellyfinUsers: (prev.jellyfinUsers ?? []).map(u => (u.id === id ? { ...u, ...patch } : u)),
    }));
  const removeUser = async (user: JellyfinUser) => {
    const held = connectedServices(user);
    if (held.length) {
      const names = held.map((service) => CARD_SERVICES[service].label).join(', ');
      if (!window.confirm(`${user.name} is connected to ${names}. Removing the user disconnects them. Continue?`)) return;
      for (const service of held) {
        const path = CARD_SERVICES[service].disconnectPath;
        if (path && auth.userUUID) {
          const result = await disconnectCardAccount(path, auth.userUUID, user.id, auth.password);
          if (!result.ok) {
            toast.error(`Could not disconnect ${user.name} from ${CARD_SERVICES[service].label}: ${result.error ?? 'unknown error'}. The user was kept.`);
            return;
          }
        }
      }
    }
    setConfig(prev => ({
      ...prev,
      jellyfinUsers: (prev.jellyfinUsers ?? []).filter(u => u.id !== user.id),
      catalogs: prev.catalogs.filter((c) => c.metadata?.accountOwner !== user.id),
    }));
  };
  const removeCatalogs = (ids: string[]) =>
    setConfig(prev => ({ ...prev, catalogs: prev.catalogs.filter((c) => !ids.includes(c.id)) }));
  const addCatalogs = (entries: CatalogConfig[]) =>
    setConfig(prev => ({ ...prev, catalogs: [...prev.catalogs, ...entries.filter((e) => !prev.catalogs.some((c) => c.id === e.id && c.type === e.type))] }));
  const nameClash = handoffNameClash(mainName, config.jellyfinUserHandoffNames, users);
  const showHandoff = showsAlsoKnownAs(config, users);
  const addUser = () => {
    const clean = newUserName.trim();
    if (!clean) return;
    if (users.some(u => u.name.toLowerCase() === clean.toLowerCase()) || clean.toLowerCase() === mainName.toLowerCase()) {
      toast.error('There is already a user with that name');
      return;
    }
    const id = newUserId();
    setConfig(prev => ({ ...prev, jellyfinUsers: [...(prev.jellyfinUsers ?? []), { id, name: clean, tags: [] }] }));
    setNewUserName('');
    setAdding(false);
    setSelected(id);
    setTab('profile');
  };

  const [forgetFor, setForgetFor] = useState<{ profile: string | null; name: string } | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const canForget = jellyfin.enabled && Boolean(userUUID);
  const forgetImported = async () => {
    if (!forgetFor) return;
    setForgetting(true);
    try {
      const response = await fetch(`/api/jellyfin/${encodeURIComponent(userUUID)}/forget-imported`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: auth.password || undefined, profile: forgetFor.profile || undefined }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Could not forget the imported history');
      toast.success(`Imported history forgotten for ${forgetFor.name}`, {
        description: `${result?.removed ?? 0} imported ${result?.removed === 1 ? 'entry' : 'entries'} removed. Plays through this server stay.`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not forget the imported history');
    } finally {
      setForgetting(false);
      setForgetFor(null);
    }
  };

  const mainPerson: Person = {
    key: 'main',
    name: mainName,
    avatar: config.jellyfinUserAvatar,
    main: true,
    user: {
      id: '',
      name: mainName,
      tags: config.jellyfinUserTags ?? [],
      trackerSource: config.jellyfinResumeSource ?? 'auto',
      skipSource: config.jellyfinSkipSource ?? 'auto',
      watchlistServices: config.jellyfinWatchlistServices,
      handoffNames: config.jellyfinUserHandoffNames,
      pin: config.jellyfinUserPin,
      streamUrl: config.jellyfinStreamUrl,
    },
    catalogCount: catalogCountFor(config.jellyfinUserTags ?? []),
    trackerOptions: resumeSourceOptions,
    watchlistOptions,
    watchedPoint: watchedPointFor('', mainName),
    accounts: mainAccounts,
    onForget: canForget ? () => setForgetFor({ profile: null, name: mainName }) : undefined,
    onChange: (patch) => setConfig(prev => ({
      ...prev,
      ...('name' in patch ? { jellyfinUserName: patch.name } : {}),
      ...('avatar' in patch ? { jellyfinUserAvatar: patch.avatar } : {}),
      ...('tags' in patch ? { jellyfinUserTags: patch.tags?.length ? patch.tags : undefined } : {}),
      ...('trackerSource' in patch ? { jellyfinResumeSource: patch.trackerSource as typeof prev.jellyfinResumeSource } : {}),
      ...('skipSource' in patch ? { jellyfinSkipSource: patch.skipSource === 'auto' ? undefined : patch.skipSource } : {}),
      ...('watchlistServices' in patch ? { jellyfinWatchlistServices: patch.watchlistServices } : {}),
      ...('handoffNames' in patch ? { jellyfinUserHandoffNames: patch.handoffNames } : {}),
      ...('pin' in patch ? { jellyfinUserPin: patch.pin } : {}),
      ...('streamUrl' in patch ? { jellyfinStreamUrl: patch.streamUrl } : {}),
    })),
  };
  const people: Person[] = [mainPerson, ...users.map((user): Person => {
    const holder = isHolder(user);
    return {
      key: user.id,
      name: user.name,
      avatar: user.avatar,
      user,
      catalogCount: catalogCountFor(user.tags),
      trackerOptions: holder ? trackerOptionsFor(user) : resumeSourceOptions,
      watchlistOptions: holder ? watchlistOptionsFor(user) : watchlistOptions,
      watchedPoint: watchedPointFor(user.id, user.name),
      accounts: holder ? connectedServices(user).map((service) => CARD_SERVICES[service].label) : [],
      onChange: (patch) => updateUser(user.id, patch),
      onRemove: () => { void removeUser(user); },
      onForget: canForget ? () => setForgetFor({ profile: user.id, name: user.name }) : undefined,
      accountsEditor: user.trackers !== true
        ? <UserAccounts user={user} catalogs={config.catalogs ?? []} onChange={(next) => updateUser(user.id, next)} onAddCatalogs={addCatalogs} onRemoveCatalogs={removeCatalogs} />
        : undefined,
    };
  })];
  const current = people.find((p) => p.key === selected) ?? mainPerson;

  return (
    <div className="space-y-3">
      <AlertDialog open={!!forgetFor} onOpenChange={(next) => !next && !forgetting && setForgetFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget imported history?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the watches and resume points imported from trackers for {forgetFor?.name}. What was played or marked through this server stays, and nothing changes on the trackers themselves. If a tracker is still picked, its history is imported again on the next sync.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forgetting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={forgetting}
              onClick={(event) => { event.preventDefault(); void forgetImported(); }}
            >
              {forgetting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Forget'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {nameClash ? <p className="text-xs text-destructive">"{nameClash}" is used by two users. Each name, including Also known as names and user ids, must belong to one user.</p> : null}
      <div className="overflow-hidden rounded-lg border bg-card md:flex">
        <nav aria-label="People" className="flex gap-1 overflow-x-auto border-b p-2 md:w-64 md:shrink-0 md:flex-col md:overflow-visible md:border-b-0 md:border-r">
          {people.map((person) => (
            <button
              key={person.key}
              type="button"
              aria-current={person.key === current.key}
              onClick={() => setSelected(person.key)}
              className={cn(
                'flex shrink-0 items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors md:w-full',
                person.key === current.key ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <Avatar src={person.avatar} name={person.name} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{person.name || 'Unnamed user'}</span>
                <span className="hidden truncate text-xs text-muted-foreground md:block">{personSummary(person)}</span>
              </span>
            </button>
          ))}
          <div className="flex shrink-0 items-center md:mt-1 md:border-t md:pt-2">
            {adding ? (
              <div className="flex items-center gap-1.5 md:w-full">
                <Input
                  value={newUserName}
                  maxLength={MAX_TAG_NAME_LENGTH}
                  placeholder="Name"
                  className="h-8 w-36 text-sm md:w-auto md:flex-1"
                  aria-label="New person's name"
                  autoFocus
                  onChange={(e) => setNewUserName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addUser();
                    if (e.key === 'Escape') { setAdding(false); setNewUserName(''); }
                  }}
                />
                <Button size="sm" className="h-8 shrink-0" onClick={addUser} disabled={!newUserName.trim()}>Add</Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground md:w-full"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-muted-foreground/50" aria-hidden="true"><Plus className="h-4 w-4" /></span>
                Add person
              </button>
            )}
          </div>
        </nav>
        <section className="min-w-0 flex-1 pb-2">
          <PersonDetail
            key={current.key}
            person={current}
            allTags={tags}
            hasPmdb={Boolean(config.apiKeys?.publicmetadb)}
            mainSkipSource={config.jellyfinSkipSource ?? 'auto'}
            showHandoff={showHandoff}
            jellyfin={jellyfin.enabled}
            stremioOn={stremioOn}
            tab={tab}
            onTab={setTab}
          />
        </section>
      </div>
    </div>
  );
}
