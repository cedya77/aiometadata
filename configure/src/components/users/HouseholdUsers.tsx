import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowRight, Camera, LayoutGrid, Loader2, MoreHorizontal, Pencil, Plus, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { useSave } from '@/contexts/SaveContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { MAX_TAG_NAME_LENGTH, type CardService, type CatalogConfig, type JellyfinUser, type SkipSource, type TagDef } from '@/contexts/config';
import { UserAccounts } from '@/components/jellyfin/UserAccounts';
import { SkipSourcePicker } from '@/components/jellyfin/SkipSourcePicker';
import { StreamAddonField } from '@/components/jellyfin/StreamAddonField';
import { Face } from '@/components/users/Face';
import { JellyfinGlyph } from '@/components/settings/JellyfinGlyph';
import { CARD_SERVICES, connectedServices, handoffNameClash, isHolder, mainConnectedServices, mainPersonName, newPersonId, personNameTaken, pinInvalid, showsAlsoKnownAs, trackerOptionsFor, watchlistOptionsFor } from '@/lib/cardAccounts';
import { disconnectCardAccount } from '@/lib/integrationCredentials';
import { useJellyfinServer } from '@/hooks/useJellyfinServer';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { hashFor, navigateToSettingsSection, parseRoute } from '@/lib/settingsRoute';
import { moveRadio, radioTabIndex } from '@/lib/radioKeys';
import { scrobblesStremio } from '@/lib/watchTracking';

const IMAGE_URL = /^https?:\/\//i;

const AVATAR_SIZES = { sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-14 w-14 text-xl' } as const;

function Avatar({ src, name, size = 'md', onClick, title, expanded }: { src?: string; name?: string; size?: keyof typeof AVATAR_SIZES; onClick?: () => void; title?: string; expanded?: boolean }) {
  const face = <Face name={name ?? ''} avatar={src} className={cn(AVATAR_SIZES[size], 'border-0')} />;
  if (!onClick) return <div className="shrink-0">{face}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-expanded={expanded}
      className="group relative shrink-0 rounded-full ring-offset-background transition hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {face}
      <span className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border bg-card text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden="true">
        <Camera className="h-3 w-3" />
      </span>
    </button>
  );
}

function EditableName({ name, main, onChange }: { name: string; main?: boolean; onChange: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const commit = () => {
    const next = draft.trim();
    if (next !== name && (next || main)) onChange(next);
    setEditing(false);
  };
  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        maxLength={MAX_TAG_NAME_LENGTH}
        className="h-9 max-w-xs text-lg font-semibold"
        aria-label={main ? 'Your name' : `Name of ${name}`}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => { setDraft(name); setEditing(true); }}
      aria-label={`Rename ${name || 'this person'}`}
      className="group flex max-w-full items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="truncate text-lg font-semibold">{name || 'Unnamed person'}</span>
      <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-70 transition-opacity group-hover:opacity-100" aria-hidden="true" />
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
        className="h-9 w-full text-sm sm:max-w-md"
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
  if (!pin && !editing) {
    return <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Set a PIN</Button>;
  }
  return (
    <div className="space-y-2">
      {saved && !editing ? (
        <div className="flex items-center gap-2">
          <span className="mr-1 text-sm text-muted-foreground">PIN set</span>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Change</Button>
          <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>Remove</Button>
        </div>
      ) : (
        <Input
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={12}
          placeholder={saved ? 'New PIN' : '4 to 12 digits'}
          className="h-9 text-sm sm:max-w-[12rem]"
          aria-label={`PIN of ${name}`}
          autoFocus={editing}
          value={saved ? '' : pin ?? ''}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '') || undefined)}
          onBlur={() => { if (!pin || saved) setEditing(false); }}
        />
      )}
      {invalid ? (
        <p className="text-xs text-destructive">A PIN is 4 to 12 digits.</p>
      ) : (
        <Note>Apps take it after the password: secret/1234. Changing it signs {main ? 'you' : 'them'} out everywhere.</Note>
      )}
    </div>
  );
}

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
  /** Why the watched point can't be set yet, while it can't. */
  watchedNote?: string;
  /** The tracking services this person writes to. */
  services: CardService[];
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
}

/** One line under a name: who this is, where their watches go and what they see. */
function PersonSummary({ person, className }: { person: Person; className?: string }) {
  const user = person.user;
  const parts: ReactNode[] = [];
  if (!person.main) parts.push(user.trackers === true ? 'You, on fewer catalogs' : 'Someone else');
  if (person.services.length && user.trackers !== true) {
    parts.push(
      <span className="flex items-center gap-1">
        {person.services.map((service) => (
          <img key={service} src={CARD_SERVICES[service].icon} alt={CARD_SERVICES[service].label} title={CARD_SERVICES[service].label} className="h-4 w-4 rounded-sm object-contain" />
        ))}
      </span>,
    );
  } else if (person.main) {
    parts.push('No trackers');
  }
  if (user.tags.length) parts.push(`${person.catalogCount} catalog${person.catalogCount === 1 ? '' : 's'}`);
  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground', className)}>
      {parts.map((part, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1.5">
          {index ? <span className="text-muted-foreground/50" aria-hidden="true">·</span> : null}
          {typeof part === 'string' ? <span className="truncate">{part}</span> : part}
        </span>
      ))}
    </span>
  );
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
      <div className="flex items-center justify-between text-xs text-muted-foreground">
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
      {saved ? null : <p className="text-xs text-muted-foreground">Save the configuration first, then set this for this person.</p>}
    </div>
  );
}

function ServiceIcons({ services }: { services: CardService[] }) {
  return (
    <span className="flex items-center gap-1.5">
      {services.map((service) => (
        <img key={service} src={CARD_SERVICES[service].icon} alt={CARD_SERVICES[service].label} title={CARD_SERVICES[service].label} className="h-5 w-5 rounded-sm object-contain" />
      ))}
    </span>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/** One setting: its name and a line on what it does on the left, the control on the right, details below. */
function SettingRow({ label, description, control, children }: { label: string; description?: string; control?: ReactNode; children?: ReactNode }) {
  return (
    <div className="grid gap-x-10 gap-y-3 py-5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <div className="space-y-1">
        <p className="text-sm font-medium">{label}</p>
        {description ? <p className="text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {control || children ? <div className="min-w-0 space-y-3">{control}{children}</div> : null}
    </div>
  );
}

function Group({ anchor, title, icon, children }: { anchor: string; title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section data-setting={anchor} aria-label={title}>
      <h4 className="flex items-center gap-2 border-b pb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="flex h-4 w-4 items-center justify-center" aria-hidden="true">{icon}</span>
        {title}
      </h4>
      <div className="divide-y divide-border/50">{children}</div>
    </section>
  );
}

function WhoChoice({ selected, title, hint, disabled, onSelect }: { selected: boolean; title: string; hint: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className={cn('mt-0.5 h-4 w-4 shrink-0 rounded-full border', selected ? 'border-[5px] border-foreground' : 'border-muted-foreground/50')} aria-hidden="true" />
      <span className="space-y-0.5">
        <span className={cn('block text-sm font-medium', !selected && 'text-foreground/80')}>{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

function PersonDetail({ person, allTags, hasPmdb, mainSkipSource, showHandoff, jellyfin, stremioOn }: PersonDetailProps) {
  const { name, avatar, main, user, catalogCount, trackerOptions, watchlistOptions, watchedPoint, watchedNote, onChange, onRemove, onForget, accountsEditor } = person;
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
  const hasProfile = !main || Boolean(showHandoff);
  const key = person.key;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b px-4 py-5 sm:px-6">
        <Avatar src={avatar} name={name} size="lg" onClick={() => setPictureOpen((v) => !v)} title={`Change the picture of ${name || 'this person'}`} expanded={pictureOpen} />
        <div className="min-w-0 flex-1">
          <EditableName key={name} name={name} main={main} onChange={(next) => onChange({ name: next })} />
          <PersonSummary person={person} className="mt-0.5 text-sm" />
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
                {onRemove ? <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onRemove()}>Remove {name || 'this person'}</DropdownMenuItem> : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      {pictureOpen || (avatar && !IMAGE_URL.test(avatar)) ? (
        <div className="flex items-center gap-2 border-b px-4 py-3 sm:px-6">
          <Input
            value={avatar ?? ''}
            placeholder="Picture address (https://...)"
            className="h-8 font-mono text-xs"
            aria-label={`Picture of ${name}`}
            autoFocus={pictureOpen}
            onChange={(e) => onChange({ avatar: e.target.value || undefined })}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setPictureOpen(false); }}
          />
          {avatar ? <Button variant="ghost" size="sm" className="h-8 shrink-0 text-xs" onClick={() => onChange({ avatar: undefined })}>Remove</Button> : null}
          <Button variant="outline" size="sm" className="h-8 shrink-0 text-xs" onClick={() => setPictureOpen(false)}>Done</Button>
        </div>
      ) : null}

      <div className="space-y-8 px-4 py-6 sm:px-6">
        {hasProfile ? (
          <Group anchor={`${key}.profile`} title="Profile" icon={<UserRound className="h-3.5 w-3.5" />}>
            {main ? null : (
              <SettingRow label="Who is this">
                <div role="radiogroup" aria-label={`Who ${name} is`} className="-mx-2 -my-2 flex flex-col gap-0.5">
                  <WhoChoice
                    selected={samePerson}
                    title="You, on fewer catalogs"
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
            {showHandoff ? (
              <SettingRow label="Also known as" description="Names AIOStreams and other apps use for this person.">
                <HandoffNamesInput names={user.handoffNames} onChange={(handoffNames) => onChange({ handoffNames })} />
              </SettingRow>
            ) : null}
          </Group>
        ) : null}

        <Group anchor={`${key}.tracking`} title="Tracking" icon={<Activity className="h-3.5 w-3.5" />}>
            {main ? (
              <SettingRow
                label="Trackers"
                description="Yours are the services you choose in Watch Tracking, next."
                control={
                  <div className="flex flex-wrap items-center gap-3">
                    {person.services.length ? <ServiceIcons services={person.services} /> : <span className="text-sm text-muted-foreground">None connected</span>}
                    <Button variant="outline" size="sm" onClick={() => navigateToSettingsSection('watch-tracking')}>Set up in Watch Tracking</Button>
                  </div>
                }
              />
            ) : samePerson ? (
              <SettingRow label="Trackers" description="Shares yours." />
            ) : accountsEditor ? (
              <SettingRow label="Trackers" description={`${name ? `${name}'s` : 'Their'} own. Once one is connected, what they play, mark or heart goes there, and their shelves read from it.`}>
                {accountsEditor}
              </SettingRow>
            ) : null}
            <SettingRow
              label="Continue Watching from"
              description={resumeSourceCaption(trackerValue, trackerOptions)}
              control={
                <Select value={trackerValue} onValueChange={(v) => onChange({ trackerSource: v === 'inherit' ? undefined : (v as JellyfinUser['trackerSource']) })}>
                  <SelectTrigger className="h-9 text-sm sm:max-w-xs" aria-label={`Continue Watching of ${name}`}><SelectValue /></SelectTrigger>
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
              <SettingRow
                label="Watchlist"
                description={samePerson || holder ? 'Where a heart in an app goes.' : 'Which shelves their Watchlist shows. Their own hearts stay on this server and never reach your trackers.'}
              >
                <WatchlistPicker value={user.watchlistServices} options={watchlistOptions} onChange={(next) => onChange({ watchlistServices: next })} inheritLabel={main || holder ? 'Every connected shelf' : samePerson ? 'Same as you' : 'Your shelves'} borrowed={!samePerson && !holder} />
              </SettingRow>
            ) : null}
        </Group>

        <Group anchor={`${key}.catalogs`} title="Catalogs" icon={<LayoutGrid className="h-3.5 w-3.5" />}>
          {allTags.length > 0 ? (
            <SettingRow label="Catalogs" description="The catalog tags this person sees. None picked shows every catalog.">
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
            <SettingRow
              label="Catalogs"
              description="Everyone sees every catalog. Give catalogs tags to show people different ones."
              control={<Button variant="outline" size="sm" onClick={() => navigateToSettingsSection('catalogs')}>Open Catalogs</Button>}
            />
          )}
        </Group>

        {jellyfin ? (
          <Group anchor={`${key}.jellyfin`} title="Jellyfin" icon={<JellyfinGlyph className="h-3.5 w-3.5" />}>
            <SettingRow
              label="PIN"
              description={main ? 'Asked when someone switches to you, and on your viewing page.' : `Asked when someone switches to ${name || 'this person'}.`}
              control={<PinField name={name} pin={user.pin} main={main} onChange={(pin) => onChange({ pin })} />}
            />
            {main ? (
              <SettingRow
                label="Stream addon and skip markers"
                description="Yours are the ones set for everyone."
                control={<Button variant="outline" size="sm" onClick={() => navigateToSettingsSection('jellyfin', 'stream-addon')}>Open Jellyfin</Button>}
              />
            ) : (
              <>
                <SettingRow label="Stream addon" description="An addon this person plays from instead of the one set for everyone.">
                  <div className="sm:max-w-xl"><StreamAddonField
                    id={`stream-addon-${user.id}`}
                    value={user.streamUrl ?? ''}
                    placeholder="Same as everyone"
                    onChange={(streamUrl) => onChange({ streamUrl })}
                  /></div>
                </SettingRow>
                <SettingRow label="Skip intro and credits" description="Where skip markers come from, asked in this order.">
                  <SkipSourcePicker
                    value={user.skipSource}
                    inherited={mainSkipSource}
                    hasPmdb={hasPmdb}
                    onChange={(skipSource) => onChange({ skipSource })}
                  />
                </SettingRow>
              </>
            )}
            <SettingRow
              label="Watched after"
              description="How far a play has to get to count as watched."
              control={watchedPoint ? <div className="sm:max-w-sm"><WatchedPointPicker name={name} point={watchedPoint} /></div> : <p className="text-xs text-muted-foreground">{watchedNote ?? 'Loading…'}</p>}
            />
          </Group>
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
function WatchlistPicker({ value, options, onChange, inheritLabel, borrowed }: { value?: string[]; options: WatchlistOption[]; onChange: (next: string[] | undefined) => void; inheritLabel: string; borrowed?: boolean }) {
  const yours = borrowed ? 'your ' : '';
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
    <div className="space-y-2.5 sm:max-w-md">
      <div className="flex flex-wrap items-center gap-1.5">
        <TagChip name={inheritLabel} onClick={() => onChange(undefined)} pressed={following} dimmed={!following} />
        <TagChip name="Keep a list on this server" onClick={() => save(!server, picked)} pressed={server} dimmed={!server} />
      </div>
      <div className="space-y-1">
        {options.map((opt) => (
          <div key={opt.value} className="flex flex-wrap items-center justify-between gap-2 py-1">
            <span className="text-sm">{borrowed ? `Your ${opt.label}` : opt.label}</span>
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
      <p className="text-xs text-muted-foreground">
        {following
          ? borrowed ? 'Every shelf of yours, read only. Switch a shelf off to leave it out.' : 'Every shelf of every connected service. Switch a shelf off to leave it out.'
          : server && !picked.length
            ? 'Only the list kept on this server.'
            : server
              ? `The ${yours}shelves switched on above, plus the list kept on this server.`
              : `Only the ${yours}shelves switched on above.`}
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



/** `#people/<key>` opens that person; `#people/<key>.<group>` also scrolls to that group of their settings. */
function linkedPerson(): string | null {
  const route = parseRoute(window.location.hash);
  if (route.section !== 'people' || !route.anchor) return null;
  return route.anchor.split('.')[0] || null;
}

/** Everyone watching on this configuration, on Stremio profiles and Jellyfin sign-ins alike. */
export function HouseholdUsers() {
  const { config, setConfig, auth } = useConfig();
  const { isSaving } = useSave();
  const jellyfin = useJellyfinServer();
  const userUUID = auth.userUUID ?? '';
  const mainName = mainPersonName(config, userUUID);
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

  const [selected, setSelected] = useState(() => linkedPerson() ?? 'main');
  const editor = useRef<HTMLDivElement>(null);
  const selectPerson = (key: string) => {
    setSelected(key);
    const next = hashFor('people', key);
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${next}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
    window.requestAnimationFrame(() => {
      const box = editor.current?.getBoundingClientRect();
      if (box && box.top > window.innerHeight * 0.6) editor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };
  useEffect(() => {
    const follow = () => {
      const key = linkedPerson();
      if (key) setSelected(key);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);
  const [adding, setAdding] = useState(false);

  const stremioOn = scrobblesStremio(config);
  const mainServices = mainConnectedServices(config);

  const catalogCountFor = (chosen: string[]) => {
    const wanted = new Set(chosen.map((t) => t.toLowerCase()));
    return (config.catalogs ?? []).filter((c) => c.enabled && (c.tags ?? []).some((t) => wanted.has(t.toLowerCase()))).length;
  };

  const [watchedPoints, setWatchedPoints] = useState<{ serverDefault: number; byProfile: Record<string, number | null> } | null>(null);
  const [watchedFailed, setWatchedFailed] = useState(false);
  useEffect(() => {
    if (!jellyfin.enabled || !userUUID || isSaving) return;
    let cancelled = false;
    fetch(`/api/jellyfin/${encodeURIComponent(userUUID)}/played-thresholds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: auth.password || undefined }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`played-thresholds ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (!data || !Array.isArray(data.profiles)) throw new Error('played-thresholds answer');
        setWatchedFailed(false);
        setWatchedPoints({
          serverDefault: Number(data.serverDefault) || 80,
          byProfile: Object.fromEntries(data.profiles.map((p: { profile: string | null; percent: number | null }) => [p.profile ?? '', p.percent ?? null])),
        });
      })
      .catch(() => { if (!cancelled) setWatchedFailed(true); });
    return () => { cancelled = true; };
  }, [jellyfin.enabled, isSaving, userUUID, auth.password]);
  const watchedNote = !userUUID ? 'Save the configuration first, then set this.' : watchedFailed ? "Couldn't load this. Reload the page to try again." : undefined;

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
      if (!window.confirm(`${user.name} is connected to ${names}. Removing them disconnects those too. Continue?`)) return;
      for (const service of held) {
        const path = CARD_SERVICES[service].disconnectPath;
        if (path && auth.userUUID) {
          const result = await disconnectCardAccount(path, auth.userUUID, user.id, auth.password);
          if (!result.ok) {
            toast.error(`Could not disconnect ${user.name} from ${CARD_SERVICES[service].label}: ${result.error ?? 'unknown error'}. ${user.name} was kept.`);
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
    if (personNameTaken(config, userUUID, clean)) {
      toast.error('There is already a person with that name');
      return;
    }
    const id = newPersonId();
    setConfig(prev => ({ ...prev, jellyfinUsers: [...(prev.jellyfinUsers ?? []), { id, name: clean, tags: [] }] }));
    setNewUserName('');
    setAdding(false);
    selectPerson(id);
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
    watchedNote,
    services: mainServices,
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
      watchedNote,
      services: holder ? connectedServices(user) : [],
      onChange: (patch) => updateUser(user.id, patch),
      onRemove: () => { void removeUser(user); },
      onForget: canForget ? () => setForgetFor({ profile: user.id, name: user.name }) : undefined,
      accountsEditor: user.trackers !== true
        ? <UserAccounts bare user={user} catalogs={config.catalogs ?? []} onChange={(next) => updateUser(user.id, next)} onAddCatalogs={addCatalogs} onRemoveCatalogs={removeCatalogs} />
        : undefined,
    };
  })];
  const current = people.find((p) => p.key === selected) ?? mainPerson;

  return (
    <div className="space-y-4">
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
      {nameClash ? <p className="text-xs text-destructive">"{nameClash}" is used by two people. Each name, including Also known as names, must belong to one person.</p> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <div role="radiogroup" aria-label="People" className="contents" onKeyDown={moveRadio}>
        {people.map((person, index) => {
          const picked = person.key === current.key;
          return (
            <button
              key={person.key}
              type="button"
              role="radio"
              aria-checked={picked}
              tabIndex={radioTabIndex(picked, index, true)}
              data-setting={picked ? person.key : undefined}
              onClick={() => selectPerson(person.key)}
              className={cn(
                'flex min-w-0 flex-col items-center gap-2 rounded-lg border bg-card px-3 py-4 text-center transition-colors',
                picked ? 'border-foreground/50 bg-accent/40 ring-1 ring-foreground/20' : 'hover:bg-accent/30',
              )}
            >
              <Avatar src={person.avatar} name={person.name} size="lg" />
              <span className="w-full truncate text-sm font-medium">
                {person.name || 'Unnamed person'}
                {person.main && person.name !== 'You' ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
              </span>
              <PersonSummary person={person} className="justify-center text-xs" />
            </button>
          );
        })}
        </div>
        {adding ? (
          <div className="flex min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-card px-3 py-4">
            <Input
              value={newUserName}
              maxLength={MAX_TAG_NAME_LENGTH}
              placeholder="Name"
              className="h-8 text-sm"
              aria-label="New person's name"
              autoFocus
              onChange={(e) => setNewUserName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addUser();
                if (e.key === 'Escape') { setAdding(false); setNewUserName(''); }
              }}
            />
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm" className="h-8" onClick={() => { setAdding(false); setNewUserName(''); }}>Cancel</Button>
              <Button size="sm" className="h-8" onClick={addUser} disabled={!newUserName.trim()}>Add</Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full border border-dashed border-muted-foreground/50" aria-hidden="true"><Plus className="h-5 w-5" /></span>
            Add person
            <span className="hidden text-xs font-normal sm:block">Their own sign-in, catalogs and trackers</span>
          </button>
        )}
      </div>

      <div ref={editor} className="scroll-mt-6 rounded-lg border bg-card">
        <PersonDetail
          key={current.key}
          person={current}
          allTags={tags}
          hasPmdb={Boolean(config.apiKeys?.publicmetadb)}
          mainSkipSource={config.jellyfinSkipSource ?? 'auto'}
          showHandoff={showHandoff}
          jellyfin={jellyfin.enabled}
          stremioOn={stremioOn}
        />
      </div>
    </div>
  );
}
