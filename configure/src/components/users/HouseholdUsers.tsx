import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, Loader2, MoreHorizontal, Plus, User } from 'lucide-react';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { useSave } from '@/contexts/SaveContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { CARD_SERVICES, connectedServices, handoffNameClash, isHolder, pinInvalid, showsAlsoKnownAs, trackerOptionsFor, userBadge, watchlistOptionsFor, type UserBadge } from '@/lib/cardAccounts';
import { disconnectCardAccount } from '@/lib/integrationCredentials';
import { useJellyfinServer } from '@/hooks/useJellyfinServer';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { navigateToSettingsSection } from '@/lib/settingsRoute';
import { scrobblesStremio, WATCH_TRACKING_SERVICE_DEFINITIONS, WATCH_TRACKING_SERVICES } from '@/lib/watchTracking';

const IMAGE_URL = /^https?:\/\//i;

function Avatar({ src, onClick, title, small }: { src?: string; onClick?: () => void; title?: string; small?: boolean }) {
  const size = small ? 'h-7 w-7' : 'h-10 w-10';
  const face = src && IMAGE_URL.test(src)
    ? <img src={src} alt="" className={cn(size, 'rounded-full object-cover bg-muted')} />
    : (
      <div className={cn(size, 'flex items-center justify-center rounded-full bg-muted text-muted-foreground')}>
        <User className={small ? 'h-4 w-4' : 'h-5 w-5'} />
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

interface UserRowProps {
  name: string;
  avatar?: string;
  main?: boolean;
  user?: JellyfinUser;
  allTags: TagDef[];
  catalogCount: number;
  trackerOptions: Array<{ value: string; label: string; animeOnly?: boolean }>;
  watchlistOptions: WatchlistOption[];
  hasPmdb: boolean;
  /** The main user's choice, which a user left on "Same as you" follows. */
  mainSkipSource: SkipSource;
  showHandoff?: boolean;
  /** Shows the Jellyfin-only settings, on an instance that runs the Jellyfin server. */
  jellyfin?: boolean;
  watchedPoint?: WatchedPoint;
  open: boolean;
  onToggle: () => void;
  /** The tracking accounts this user writes to, named on the closed card. */
  accounts: string[];
  /** Stremio SDK scrobbling is on, so the user has an install link in Configuration. */
  stremioOn: boolean;
  onChange: (patch: Partial<JellyfinUser>) => void;
  onRemove?: () => void;
  onForget?: () => void;
  children?: ReactNode;
}

const BADGE_STYLES: Record<UserBadge, string> = {
  'You': 'border-primary/40 bg-primary/15 text-primary',
  'Same person': 'border-sky-500/40 text-sky-400',
  'Own accounts': 'border-emerald-500/40 text-emerald-400',
  'Someone else': 'border-muted-foreground/30 text-muted-foreground',
};

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
function SettingNotes({ children }: { children: ReactNode }) {
  return <div className="space-y-1 rounded-md bg-muted/30 px-3 py-2">{children}</div>;
}

function CardSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function UserRow({ name, avatar, main, user, allTags, catalogCount, trackerOptions, watchlistOptions, hasPmdb, mainSkipSource, showHandoff, jellyfin, watchedPoint, open, onToggle, accounts, stremioOn, onChange, onRemove, onForget, children }: UserRowProps) {
  const chosen = user?.tags ?? [];
  const toggleTag = (tag: string) =>
    onChange({ tags: chosen.includes(tag) ? chosen.filter((t) => t !== tag) : [...chosen, tag] });
  const caps = allTags
    .filter((t) => chosen.includes(t.name) && t.ageRating && t.ageRating !== 'None')
    .map((t) => t.ageRating as string);
  const samePerson = main || user?.trackers === true;
  const holder = !main && isHolder(user);
  const [pictureOpen, setPictureOpen] = useState(false);
  // Open from the start when something there needs attention: a bad PIN, or no addon to play from.
  const [jellyfinOpen, setJellyfinOpen] = useState(() => pinInvalid(user?.pin) || Boolean(main && !user?.streamUrl));

  const scope = `${catalogCount} catalog${catalogCount === 1 ? '' : 's'}`;
  const capNote = caps.length ? <span className="rounded-full border border-amber-500/40 px-1.5 text-[11px] text-amber-400">{caps.join(', ')} and lower</span> : null;

  // A holder that has lost the service its pick named (e.g. disconnected it) falls back to Automatic.
  const rawTrackerSource = user?.trackerSource;
  const trackerKnown = rawTrackerSource === 'auto' || rawTrackerSource === 'off' || trackerOptions.some((opt) => opt.value === rawTrackerSource);
  const trackerValue = holder && rawTrackerSource && !trackerKnown ? 'auto' : rawTrackerSource ?? (main || holder ? 'auto' : 'inherit');
  const trackerCaption = trackerValue === 'inherit' ? 'Same as you: follows your own card.' : resumeSourceCaption(trackerValue, trackerOptions);

  const badge = userBadge(user, Boolean(main));
  const canForget = Boolean(onForget) && (main || !samePerson);
  const hasMenu = canForget || Boolean(onRemove);
  const openInstallLink = () => navigateToSettingsSection('configuration', `install-link-${user?.id || 'main'}`);

  return (
    <div id={`user-card-${user?.id || 'main'}`} className={cn('scroll-mt-16 rounded-lg border', open ? 'space-y-3 p-4' : 'px-3 py-2')}>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left">
          <Avatar src={avatar} small />
          <span className="truncate text-sm font-medium">{name || 'Unnamed user'}</span>
          <span className={cn('rounded-full border px-2 py-0.5 text-[11px] font-medium', BADGE_STYLES[badge])}>{badge}</span>
          {accounts.length ? <span className="text-[11px] text-muted-foreground">{accounts.join(' · ')}</span> : null}
          <span className="text-[11px] text-muted-foreground">{chosen.length ? scope : 'All catalogs'}</span>
        </button>
        {stremioOn ? (
          <Button variant="ghost" size="sm" className="hidden h-7 gap-1 text-xs sm:inline-flex" onClick={openInstallLink}>
            Install link <ArrowRight className="h-3 w-3" />
          </Button>
        ) : null}
        {hasMenu || stremioOn ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className={cn('h-7 w-7 p-0 text-muted-foreground', !hasMenu && 'sm:hidden')} aria-label={`More for ${name}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {stremioOn ? <DropdownMenuItem className="sm:hidden" onSelect={openInstallLink}>Install link</DropdownMenuItem> : null}
              {stremioOn && hasMenu ? <DropdownMenuSeparator className="sm:hidden" /> : null}
              {canForget ? <DropdownMenuItem onSelect={() => onForget?.()}>Forget imported history</DropdownMenuItem> : null}
              {canForget && onRemove ? <DropdownMenuSeparator /> : null}
              {onRemove ? <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onRemove()}>Remove {name || 'this user'}</DropdownMenuItem> : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground" aria-label={open ? `Close ${name}` : `Open ${name}`} onClick={onToggle}>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </div>
      {open ? (
      <>
      <div className="flex items-start gap-3 border-t pt-3">
        <Avatar src={avatar} onClick={() => setPictureOpen((v) => !v)} title={`Picture of ${name}`} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={name}
              maxLength={MAX_TAG_NAME_LENGTH}
              className="h-8 min-w-[10rem] flex-1 text-sm"
              aria-label={main ? 'Name of the main user' : `Name of ${name}`}
              onChange={(e) => onChange({ name: e.target.value })}
            />
            {main ? (
              <span className="rounded-full border border-primary/40 bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">You</span>
            ) : (
              <label className="flex items-center gap-1.5 text-xs" title={holder ? 'Disconnect this user’s accounts first: a user with accounts of their own is someone else.' : 'On: this is you on fewer catalogs, sharing your Continue Watching, watched marks and trackers. Off: someone else, with their own.'}>
                <Switch checked={samePerson} disabled={holder} onCheckedChange={(next) => onChange({ trackers: next || undefined })} aria-label={`${name} is the same person as you`} />
                Same person as you
              </label>
            )}
          </div>
          {pictureOpen || (avatar && !IMAGE_URL.test(avatar)) ? (
            <Input
              value={avatar ?? ''}
              placeholder="Picture address (https://...)"
              className="h-8 font-mono text-xs"
              aria-label={`Picture of ${name}`}
              autoFocus={pictureOpen}
              onChange={(e) => onChange({ avatar: e.target.value || undefined })}
            />
          ) : (
            <Note>{main ? 'Your history and trackers.' : samePerson ? 'You on fewer catalogs: shares your history and writes your trackers; the picks below can differ.' : holder ? 'Someone else, on the accounts connected below.' : 'Someone else with their own history; nothing reaches your trackers.'} Click the picture to change it.</Note>
          )}
        </div>
      </div>

      <CardSection title="Tracking">
        <div className="divide-y">
          <SettingRow
            label={main ? 'Your trackers' : holder ? 'Their trackers' : 'Trackers this user reads'}
            description="Where Continue Watching, Next Up and the watched ticks come from."
            control={
              <Select value={trackerValue} onValueChange={(v) => onChange({ trackerSource: v === 'inherit' ? undefined : (v as JellyfinUser['trackerSource']) })}>
                <SelectTrigger className="h-8 text-xs" aria-label={`Trackers of ${name}`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {!main && !holder && <SelectItem value="inherit">Same as you</SelectItem>}
                  <SelectItem value="auto">Automatic</SelectItem>
                  {trackerOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                  <SelectItem value="off">This server only</SelectItem>
                </SelectContent>
              </Select>
            }
          >
            <SettingNotes>
              <Note>{trackerCaption}</Note>
              {canForget && (
                <Note>What is read is also imported here and stays if you change this. Clear it with Forget imported history in the … menu.</Note>
              )}
              {main && (
                <Note>Plays through this server always win over a tracker's view. Only services that store positions are listed, so not AniList or MyAnimeList.</Note>
              )}
              {main && trackerOptions.length === 0 && (
                <Note>No connected service stores positions, so only plays here are shown. Fine for a single client.</Note>
              )}
            </SettingNotes>
          </SettingRow>
          {watchlistOptions.length > 0 && (
            <SettingRow label="Watchlist" description="The shelves a heart in a client reads from and writes to.">
              <WatchlistPicker value={user?.watchlistServices} options={watchlistOptions} onChange={(next) => onChange({ watchlistServices: next })} inheritLabel={main || holder ? 'Every connected shelf' : 'Same as you'} />
              <SettingNotes>
                <Note>A heart in a client writes to the picked shelves that take that title. MDBList and Trakt file anime under movies and series; Simkl, AniList and MyAnimeList keep an anime shelf.</Note>
              </SettingNotes>
            </SettingRow>
          )}
          {watchedPoint ? (
            <SettingRow
              label="Watched at"
              description="Played this far, a title counts as watched; stopping earlier keeps it in Continue Watching. Simkl gets the same point. Saves on its own."
              control={<WatchedPointPicker name={name} point={watchedPoint} />}
            />
          ) : null}
          {showHandoff ? (
            <SettingRow label="Also known as" description="Names AIOStreams and other apps use for this person, comma separated.">
              <HandoffNamesInput names={user?.handoffNames} onChange={(handoffNames) => onChange({ handoffNames })} />
            </SettingRow>
          ) : null}
        </div>
        {children ? <div className="border-t pt-3">{children}</div> : null}
      </CardSection>

      {allTags.length > 0 ? (
        <CardSection title="Catalogs">
          <SettingRow
            label="Tags"
            description="This user sees the catalogs carrying any of the picked tags, under their rating limit. None picked shows every catalog. Tags are made in Catalogs."
          >
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
            <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{chosen.length === 0 ? 'No tag picked: every catalog' : scope}</span>
              {capNote}
            </span>
          </div>
          </SettingRow>
        </CardSection>
      ) : null}

      {jellyfin ? (
        <div className="border-t pt-3">
          <button
            type="button"
            className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
            aria-expanded={jellyfinOpen}
            onClick={() => setJellyfinOpen((v) => !v)}
          >
            <span className="flex items-center gap-1.5">
              <img src="/jellyfin_icon.svg" alt="" aria-hidden="true" className="h-3.5 w-3.5 object-contain" />
              Jellyfin
            </span>
            {jellyfinOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {jellyfinOpen ? (
            <div className="mt-2 divide-y">
              <SettingRow
                label="Stream addon"
                description={main
                  ? "The addon titles play from on Jellyfin, such as your AIOStreams. Without one, titles browse but won't play. Also in the Jellyfin settings under Configuration."
                  : 'An addon this user plays from instead of yours. Empty follows yours.'}
                control={
                  <Input
                    id={main ? 'jellyfin-main-stream-url' : undefined}
                    className="h-8 font-mono text-xs"
                    placeholder={main ? 'https://your-aiostreams/stremio/<config>/manifest.json' : 'Same as you'}
                    aria-label={`Stream addon of ${name}`}
                    value={user?.streamUrl ?? ''}
                    onChange={(e) => onChange({ streamUrl: e.target.value.trim() ? e.target.value : undefined })}
                  />
                }
              >
                {main && !user?.streamUrl ? <p className="text-[11px] text-amber-400">No stream addon set, so Jellyfin clients can browse but not play.</p> : null}
              </SettingRow>
              <SettingRow
                label="PIN"
                description={main ? 'Asked whenever another user switches to you.' : 'Asked whenever someone switches to this user.'}
                control={<PinField name={name} pin={user?.pin} main={main} onChange={(pin) => onChange({ pin })} />}
              />
              <SettingRow label="Skip intro and credits" description="Where the skip markers a client shows come from, asked in this order.">
                <SkipSourcePicker
                  value={user?.skipSource ?? (main ? 'auto' : undefined)}
                  inherited={mainSkipSource}
                  main={main}
                  hasPmdb={hasPmdb}
                  onChange={(skipSource) => onChange({ skipSource })}
                />
              </SettingRow>
            </div>
          ) : null}
        </div>
      ) : null}
      </>
      ) : null}
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
  if (value === 'off') {
    return 'This server only: Continue Watching, Next Up and the ticks come from plays here. Trackers are still told about plays but never read.';
  }
  if (value === 'auto') {
    const names = options.filter((o) => !o.animeOnly).map((o) => o.label);
    const list = names.length ? names.join(' and ') : 'a connected tracker';
    return `Automatic: Continue Watching merges paused titles from ${list}, newest first. Ticks, Next Up and Upcoming come from the first connected of MDBList, Simkl, PublicMetaDB. AniList and MyAnimeList are read only when picked.`;
  }
  const option = options.find((o) => o.value === value);
  if (option?.animeOnly) {
    return `${option.label} only: ticks, Next Up and Upcoming come from your ${option.label} anime list plus plays here. It covers anime only and keeps no positions, so Continue Watching is what you pause here. It counts episodes rather than tracking each, so unwatching an earlier episode shows only here.`;
  }
  const name = option?.label ?? 'that tracker';
  return `${name} only: Continue Watching, ticks, Next Up and Upcoming come from ${name} plus plays here. Pick it when trackers disagree.`;
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

  // One card open at a time keeps the list short; a lone user is open from the start.
  const [openCard, setOpenCard] = useState<string | null>(() => ((config.jellyfinUsers ?? []).length === 0 ? 'main' : null));
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (!scrollTo) return;
    document.getElementById(`user-card-${scrollTo}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setScrollTo(null);
  }, [scrollTo]);
  const toggleCard = (key: string) => setOpenCard((current) => (current === key ? null : key));

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
    setOpenCard(id);
    setScrollTo(id);
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
      <div className="flex items-center gap-2">
        <Input
          value={newUserName}
          maxLength={MAX_TAG_NAME_LENGTH}
          placeholder="New user name"
          className="h-8 text-sm"
          aria-label="New user name"
          onChange={(e) => setNewUserName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addUser(); }}
        />
        <Button size="sm" className="shrink-0 whitespace-nowrap" onClick={addUser} disabled={!newUserName.trim()}>
          <Plus className="mr-1 h-4 w-4" /> Add user
        </Button>
      </div>
      {nameClash ? <p className="text-xs text-destructive">"{nameClash}" is used by two users. Each name, including Also known as names and user ids, must belong to one user.</p> : null}
      <UserRow
        main
        name={mainName}
        avatar={config.jellyfinUserAvatar}
        user={{
          id: '',
          name: mainName,
          tags: config.jellyfinUserTags ?? [],
          trackerSource: config.jellyfinResumeSource ?? 'auto',
          skipSource: config.jellyfinSkipSource ?? 'auto',
          watchlistServices: config.jellyfinWatchlistServices,
          handoffNames: config.jellyfinUserHandoffNames,
          pin: config.jellyfinUserPin,
          streamUrl: config.jellyfinStreamUrl,
        }}
        allTags={tags}
        catalogCount={catalogCountFor(config.jellyfinUserTags ?? [])}
        trackerOptions={resumeSourceOptions}
        watchlistOptions={watchlistOptions}
        hasPmdb={Boolean(config.apiKeys?.publicmetadb)}
        mainSkipSource={config.jellyfinSkipSource ?? 'auto'}
        showHandoff={showHandoff}
        jellyfin={jellyfin.enabled}
        watchedPoint={watchedPointFor('', mainName)}
        open={openCard === 'main'}
        onToggle={() => toggleCard('main')}
        accounts={mainAccounts}
        stremioOn={stremioOn}
        onForget={canForget ? () => setForgetFor({ profile: null, name: mainName }) : undefined}
        onChange={(patch) => setConfig(prev => ({
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
        }))}
      />
      {users.map((user) => {
        const holder = isHolder(user);
        return (
          <UserRow
            key={user.id}
            name={user.name}
            avatar={user.avatar}
            user={user}
            allTags={tags}
            catalogCount={catalogCountFor(user.tags)}
            trackerOptions={holder ? trackerOptionsFor(user) : resumeSourceOptions}
            watchlistOptions={holder ? watchlistOptionsFor(user) : watchlistOptions}
            hasPmdb={Boolean(config.apiKeys?.publicmetadb)}
            mainSkipSource={config.jellyfinSkipSource ?? 'auto'}
            showHandoff={showHandoff}
            jellyfin={jellyfin.enabled}
            watchedPoint={watchedPointFor(user.id, user.name)}
            open={openCard === user.id}
            onToggle={() => toggleCard(user.id)}
            accounts={holder ? connectedServices(user).map((service) => CARD_SERVICES[service].label) : []}
            stremioOn={stremioOn}
            onChange={(patch) => updateUser(user.id, patch)}
            onRemove={() => { void removeUser(user); }}
            onForget={canForget ? () => setForgetFor({ profile: user.id, name: user.name }) : undefined}
          >
            {user.trackers !== true ? (
              <UserAccounts user={user} catalogs={config.catalogs ?? []} onChange={(next) => updateUser(user.id, next)} onAddCatalogs={addCatalogs} onRemoveCatalogs={removeCatalogs} />
            ) : null}
          </UserRow>
        );
      })}
    </div>
  );
}
