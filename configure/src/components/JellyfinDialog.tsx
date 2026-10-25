import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { useSave } from "@/contexts/SaveContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronDown, ChevronUp, Copy, Loader2, Plus, Save, User, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TagChip } from "@/components/TagChip";
import { MAX_TAG_NAME_LENGTH, type CatalogConfig, type JellyfinUser, type SkipProvider, type SkipSource, type TagDef } from "@/contexts/config";
import { UserAccounts } from "@/components/jellyfin/UserAccounts";
import { CARD_SERVICES, connectedServices, handoffNameClash, isHolder, trackerOptionsFor, watchlistOptionsFor } from "@/lib/cardAccounts";
import { disconnectCardAccount } from "@/lib/integrationCredentials";

/**
 * Typed by hand on a TV remote as often as pasted, so the alphabet leaves out
 * the characters that are read wrong and the groups keep the place visible.
 */
function newClientPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard!`);
  } catch (err) {
    console.error('Copy failed:', err);
    toast.error('Failed to copy to clipboard');
  }
}

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
    <div className="flex flex-wrap items-center gap-2">
      <Label className="text-xs text-muted-foreground">Also known as (AIOStreams)</Label>
      <Input
        className="h-8 min-w-[12rem] flex-1 text-xs"
        placeholder="Names this user has on AIOStreams' Jellyfin server, comma separated"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      />
    </div>
  );
}

const PIN_PATTERN = /^\d{4,12}$/;
const SAVED_PIN = /^\$2[aby]\$/;

function pinInvalid(pin?: string): boolean {
  return Boolean(pin && !SAVED_PIN.test(pin) && !PIN_PATTERN.test(pin));
}

function PinField({ name, pin, main, onChange }: { name: string; pin?: string; main?: boolean; onChange: (pin: string | undefined) => void }) {
  const [editing, setEditing] = useState(false);
  const saved = Boolean(pin && SAVED_PIN.test(pin));
  const invalid = pinInvalid(pin);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">PIN</Label>
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
      <p className={cn('text-[11px]', invalid ? 'text-destructive' : 'text-muted-foreground')}>
        {invalid
          ? 'A PIN is 4 to 12 digits.'
          : main
            ? 'Asked whenever another user switches to you. To sign in as you on a client, enter the password, a slash and the PIN, like password/1234. Setting or changing it signs you out on every device.'
            : 'Asked whenever someone switches to this user, from your own user too. To sign in as them on a client, enter the password, a slash and the PIN, like password/1234. Setting or changing it signs this user out on every device.'}
      </p>
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
  watchedPoint?: WatchedPoint;
  onChange: (patch: Partial<JellyfinUser>) => void;
  onRemove?: () => void;
  onForget?: () => void;
  children?: ReactNode;
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
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={`watched-${name}`} className="text-xs font-medium">Watched at</Label>
        <span className="text-xs tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">{shown}%</span>
          {following ? ' (server default)' : null}
        </span>
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
      <p className="text-[11px] text-muted-foreground">
        {saved
          ? 'Played this far, a title counts as watched; stopping earlier keeps it in Continue Watching. Simkl gets the same point. Saves on its own.'
          : 'Save the configuration first, then set when a title counts as watched for this user.'}
      </p>
    </div>
  );
}

function UserRow({ name, avatar, main, user, allTags, catalogCount, trackerOptions, watchlistOptions, hasPmdb, mainSkipSource, showHandoff, watchedPoint, onChange, onRemove, onForget, children }: UserRowProps) {
  const chosen = user?.tags ?? [];
  const toggleTag = (tag: string) =>
    onChange({ tags: chosen.includes(tag) ? chosen.filter((t) => t !== tag) : [...chosen, tag] });
  const caps = allTags
    .filter((t) => chosen.includes(t.name) && t.ageRating && t.ageRating !== 'None')
    .map((t) => t.ageRating as string);
  const samePerson = main || user?.trackers === true;
  const holder = !main && isHolder(user);
  const [pictureOpen, setPictureOpen] = useState(false);

  const scope = `${catalogCount} catalog${catalogCount === 1 ? '' : 's'}`;
  const capNote = caps.length ? <span className="rounded-full border border-amber-500/40 px-1.5 text-[11px] text-amber-400">{caps.join(', ')} and lower</span> : null;

  // A holder that has lost the service its pick named (e.g. disconnected it) falls back to Automatic.
  const rawTrackerSource = user?.trackerSource;
  const trackerKnown = rawTrackerSource === 'auto' || rawTrackerSource === 'off' || trackerOptions.some((opt) => opt.value === rawTrackerSource);
  const trackerValue = holder && rawTrackerSource && !trackerKnown ? 'auto' : rawTrackerSource ?? (main || holder ? 'auto' : 'inherit');
  const trackerCaption = trackerValue === 'inherit' ? 'Same as you: follows the choice on your own card.' : resumeSourceCaption(trackerValue, trackerOptions);

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-start gap-3">
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
            {onRemove ? (
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground" aria-label={`Remove ${name}`} onClick={onRemove}>
                <X className="h-4 w-4" />
              </Button>
            ) : null}
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
            <p className="text-[11px] text-muted-foreground">
              {main ? 'Your Continue Watching, watched marks and trackers.' : samePerson ? 'You on these catalogs: shares your Continue Watching and watched marks, and writes your trackers; the picks below can still differ from your own card.' : holder ? 'Someone else, on their own accounts: their own Continue Watching, watched marks and watchlist, read from and written to the trackers connected below.' : 'Someone else: their own Continue Watching, watched marks and watchlist. Nothing they do reaches your trackers.'} Click the picture to change it.
            </p>
          )}
        </div>
      </div>
      {allTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Tags:</span>
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
      ) : null}
      <div className="grid gap-4 border-t pt-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">{main ? 'Your trackers' : holder ? 'Their trackers' : 'Trackers this user reads'}</Label>
          <Select value={trackerValue} onValueChange={(v) => onChange({ trackerSource: v === 'inherit' ? undefined : (v as JellyfinUser['trackerSource']) })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {!main && !holder && <SelectItem value="inherit">Same as you</SelectItem>}
              <SelectItem value="auto">Automatic</SelectItem>
              {trackerOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
              <SelectItem value="off">This server only</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">{trackerCaption}</p>
          {onForget && (main || !samePerson) && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-muted-foreground">
                The tracker read here is also imported into this server, history and resume points alike, and what is imported stays when the choice changes, even to This server only.
              </p>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onForget}>
                Forget imported history
              </Button>
            </div>
          )}
          {main && (
            <p className="text-[11px] text-muted-foreground">
              Whatever is picked, what is played through this server is remembered here and always wins over a tracker's view of the same title. Only services that store a playback position are offered, so AniList and MyAnimeList are not.
            </p>
          )}
          {main && trackerOptions.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              No connected service stores playback positions, so only what is played through this server is shown. That is enough for a single client.
            </p>
          )}
        </div>
        {watchlistOptions.length > 0 && (
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Watchlist</Label>
            <WatchlistPicker value={user?.watchlistServices} options={watchlistOptions} onChange={(next) => onChange({ watchlistServices: next })} inheritLabel={main || holder ? 'Every connected' : 'Same as you'} />
            <p className="text-[11px] text-muted-foreground">
              A client's favourites are the watchlist: the picked shelves merged, and a heart on a title in a client writes to the shelves that take it. This server keeps the hearts set here as a list of its own, alone or alongside the picked shelves. MDBList and Trakt file anime under movies and series; Simkl, AniList and MyAnimeList keep an anime shelf.
            </p>
          </div>
        )}
        {!main && (
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Stream addon</Label>
            <Input
              className="h-8 text-xs"
              placeholder="Same as you"
              value={user?.streamUrl ?? ''}
              onChange={(e) => onChange({ streamUrl: e.target.value.trim() ? e.target.value : undefined })}
            />
            <p className="text-[11px] text-muted-foreground">
              An address this user plays from instead of the one above, so a user can be pointed at a different addon. Empty follows yours.
            </p>
          </div>
        )}
        <PinField name={name} pin={user?.pin} main={main} onChange={(pin) => onChange({ pin })} />
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Skip intro and credits</Label>
          <SkipSourcePicker
            value={user?.skipSource ?? (main ? 'auto' : undefined)}
            inherited={mainSkipSource}
            main={main}
            hasPmdb={hasPmdb}
            onChange={(skipSource) => onChange({ skipSource })}
          />
        </div>
        {watchedPoint ? <WatchedPointPicker name={name} point={watchedPoint} /> : null}
      </div>
      {showHandoff ? <HandoffNamesInput names={user?.handoffNames} onChange={(handoffNames) => onChange({ handoffNames })} /> : null}
      {children}
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
  const toggle = (token: string) => save(server, picked.includes(token) ? picked.filter((t) => t !== token) : [...picked, token]);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <TagChip name={inheritLabel} onClick={() => onChange(undefined)} pressed={!server && picked.length === 0} dimmed={server || picked.length > 0} />
        <TagChip name="This server" onClick={() => save(!server, picked)} pressed={server} dimmed={!server} />
      </div>
      {options.map((opt) => (
        <div key={opt.value} className="flex flex-wrap items-center gap-1.5">
          <span className="w-24 shrink-0 text-xs text-muted-foreground">{opt.label}</span>
          {opt.shelves.map((shelf) => {
            const token = `${opt.value}:${shelf}`;
            return <TagChip key={token} name={SHELF_LABELS[shelf]} onClick={() => toggle(token)} pressed={picked.includes(token)} dimmed={!picked.includes(token)} />;
          })}
        </div>
      ))}
    </div>
  );
}

function resumeSourceCaption(value: string, options: Array<{ value: string; label: string; animeOnly?: boolean }>): string {
  if (value === 'off') {
    return 'This server only: Continue Watching, Next Up and the watched ticks come from what you play through this server, on this configuration. Nothing watched elsewhere appears, and nothing is read from your trackers; plays are still reported to them. Favourites follow the watchlist picks below, which have their own "This server".';
  }
  if (value === 'auto') {
    const names = options.filter((o) => !o.animeOnly).map((o) => o.label);
    const list = names.length ? names.join(' and ') : 'a connected tracker';
    return `Automatic: Continue Watching merges the paused titles of every connected tracker (${list}), newest first. The watched ticks, Next Up and Upcoming come from one of them, the first connected in the order MDBList, Simkl, PublicMetaDB. AniList and MyAnimeList are only read when picked.`;
  }
  const option = options.find((o) => o.value === value);
  if (option?.animeOnly) {
    return `${option.label} only: the watched ticks, Next Up and Upcoming come from your ${option.label} anime list, on top of what you play here. It covers anime alone, so other shows only appear from your plays here, and it keeps no positions, so Continue Watching is what you pause here. It also keeps a count of episodes watched rather than each one, so unwatching the latest episode lowers the count, while unwatching an earlier one leaves the count as it is and shows that episode unwatched here only.`;
  }
  const name = option?.label ?? 'that tracker';
  return `${name} only: Continue Watching, the watched ticks, Next Up and Upcoming all come from ${name}, on top of what you play here. Pick this when two trackers disagree and you want one to win.`;
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

interface JellyfinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userUUID: string;
}

export function JellyfinDialog({ open, onOpenChange, userUUID }: JellyfinDialogProps) {
  const { config, setConfig, auth } = useConfig();
  const { requestSave, isSaving, isDirty, canSave } = useSave();
  const [resolveMode, setResolveMode] = useState<string>('user');
  const [upcomingMode, setUpcomingMode] = useState<string>('user');
  const [baseUrl, setBaseUrl] = useState<string>(window.location.origin);
  const serverAddress = `${baseUrl.replace(/\/+$/, '')}/jellyfin/${userUUID}`;
  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.jellyfinResolveOnOpen) setResolveMode(String(data.jellyfinResolveOnOpen));
        if (data.jellyfinUpcomingMode) setUpcomingMode(String(data.jellyfinUpcomingMode));
        if (typeof data.jellyfinBaseUrl === 'string' && data.jellyfinBaseUrl.trim()) setBaseUrl(data.jellyfinBaseUrl.trim());
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const resolveForced: boolean | null = resolveMode === 'always' ? true : resolveMode === 'never' ? false : null;
  const upcomingForced = upcomingMode === 'caught-up' || upcomingMode === 'airing' ? upcomingMode : null;
  const mainName = config.jellyfinUserName || config.addonName || userUUID.slice(0, 8);
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

  const catalogCountFor = (chosen: string[]) => {
    const wanted = new Set(chosen.map((t) => t.toLowerCase()));
    return (config.catalogs ?? []).filter((c) => c.enabled && (c.tags ?? []).some((t) => wanted.has(t.toLowerCase()))).length;
  };

  const [watchedPoints, setWatchedPoints] = useState<{ serverDefault: number; byProfile: Record<string, number | null> } | null>(null);
  useEffect(() => {
    if (!open || isSaving) return;
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
  }, [open, isSaving, userUUID, auth.password]);

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
  const badPin = pinInvalid(config.jellyfinUserPin) || users.some((user) => pinInvalid(user.pin));
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
  };

  const [quickConnectCode, setQuickConnectCode] = useState('');
  const [quickConnectProfile, setQuickConnectProfile] = useState('');
  const [approving, setApproving] = useState(false);
  const [forgetFor, setForgetFor] = useState<{ profile: string | null; name: string } | null>(null);
  const [forgetting, setForgetting] = useState(false);


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
  }, [
    config.apiKeys?.mdblist,
    config.apiKeys?.simklTokenId,
    config.apiKeys?.publicmetadb,
    config.apiKeys?.anilistTokenId,
    config.apiKeys?.malTokenId,
    config.mdblistWatchTracking,
    config.simklWatchTracking,
    config.publicmetadbWatchTracking,
    config.anilistWatchTracking,
    config.malWatchTracking,
  ]);

  const approveQuickConnect = async () => {
    const code = quickConnectCode.replace(/\D/g, '');
    if (code.length !== 6) {
      toast.error('Enter the six digit code the client is showing');
      return;
    }
    setApproving(true);
    try {
      const response = await fetch(`/api/jellyfin/${encodeURIComponent(userUUID)}/quick-connect/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, password: auth.password || undefined, profile: quickConnectProfile || undefined }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || 'Could not approve the device');
      setQuickConnectCode('');
      toast.success(`${result?.app || 'Client'} signed in`, {
        description: result?.device ? `Approved ${result.device} as ${result?.profile || mainName}.` : undefined,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not approve the device');
    } finally {
      setApproving(false);
    }
  };

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
    <>
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-[min(96vw,80rem)] overflow-y-auto sm:max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <img src="/jellyfin_icon.svg" alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
            Jellyfin
          </DialogTitle>
          <DialogDescription>
            Browse this configuration from any Jellyfin client.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="jellyfin-server-address" className="text-sm font-medium">Server address</Label>
            <div className="flex items-center gap-2">
              <Input
                id="jellyfin-server-address"
                value={serverAddress}
                readOnly
                className="font-mono text-sm"
                aria-label="Jellyfin server address"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(serverAddress, 'Jellyfin server address')}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Add this as a server in your Jellyfin client. Pick a user on its sign-in screen, then use this configuration's password, the client password below, or Quick Connect.
            </p>
            <p className="text-xs text-amber-400">
              Anyone with this address and your password can browse your catalogs. Treat it like the install URL.
            </p>
          </div>

          <div className="grid gap-6 border-t pt-4 md:grid-cols-3">
            <div className="space-y-6">
              <div className="space-y-1.5">
                <Label htmlFor="jellyfin-quick-connect" className="text-sm font-medium">Quick Connect</Label>
                <div className="flex flex-col gap-2">
                  {users.length > 0 ? (
                    <Select value={quickConnectProfile || '__main__'} onValueChange={(v) => setQuickConnectProfile(v === '__main__' ? '' : v)}>
                      <SelectTrigger className="w-full" aria-label="Sign the device in as">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__main__">{mainName}</SelectItem>
                        {users.map((u) => (
                          <SelectItem key={u.id} value={u.id}>{u.name || 'Unnamed user'}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <div className="flex flex-1 items-center gap-2">
                  <Input
                    id="jellyfin-quick-connect"
                    value={quickConnectCode}
                    inputMode="numeric"
                    maxLength={7}
                    placeholder="000000"
                    className="font-mono text-sm tracking-widest"
                    onChange={(e) => setQuickConnectCode(e.target.value.replace(/[^\d ]/g, ''))}
                    onKeyDown={(e) => { if (e.key === 'Enter') approveQuickConnect(); }}
                    aria-label="Quick Connect code"
                  />
                  <Button size="sm" variant="outline" disabled={approving} onClick={approveQuickConnect}>
                    {approving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Approve
                  </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Pick Quick Connect on the client's sign-in screen and enter the code it shows here. The client signs in without a password{users.length > 0 ? ', as the user chosen here' : ''}.
                </p>
              </div>
  
              <div className="space-y-1.5">
                <Label htmlFor="jellyfin-client-password" className="text-sm font-medium">Client password</Label>
                {config.jellyfinAppPassword ? (
                  <div className="flex items-center gap-2">
                    <Input
                      id="jellyfin-client-password"
                      value={config.jellyfinAppPassword}
                      readOnly
                      className="font-mono text-sm"
                      aria-label="Jellyfin client password"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(config.jellyfinAppPassword ?? '', 'Client password')}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfig(prev => ({ ...prev, jellyfinAppPassword: newClientPassword() }))}
                    >
                      Replace
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setConfig(prev => ({ ...prev, jellyfinAppPassword: newClientPassword() }))}
                  >
                    Generate
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  For clients without Quick Connect. Sign in with this instead of the configuration password, which an account created through a sign-in provider never set. It works only on this address, and replacing it signs the clients out.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="jellyfin-stream-url" className="text-sm font-medium">Playback</Label>
                <span className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  config.jellyfinStreamUrl
                    ? 'border-emerald-500/40 text-emerald-400'
                    : 'border-amber-500/40 text-amber-400',
                )}>
                  {config.jellyfinStreamUrl ? 'Stream addon set' : 'Browse only'}
                </span>
              </div>
              <Input
                id="jellyfin-stream-url"
                value={config.jellyfinStreamUrl ?? ''}
                placeholder="https://your-aiostreams/stremio/<config>/manifest.json"
                className="font-mono text-xs"
                onChange={(e) => setConfig(prev => ({ ...prev, jellyfinStreamUrl: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Paste a stream addon's install URL, such as your AIOStreams. Without one, titles browse but will not play. AIOMetadata never serves the video itself; the client fetches it from that addon directly.
              </p>
              <div className="flex items-center justify-between gap-3 pt-1">
                <div>
                  <Label className="text-xs font-medium">Wait for the streams when a title opens</Label>
                  <p className="text-[11px] text-muted-foreground">
                    {resolveForced === null
                      ? 'Off, a title opens at once and its versions load when the picker opens or play is pressed, the lightest on your stream addon. On, a title still opens at once while its streams load alongside, and the app gets the versions as soon as it asks again or opens the picker, usually with no wait. An app that asks for the versions with the title gets them either way.'
                      : 'Set by this server.'}
                  </p>
                </div>
                <Switch
                  checked={resolveForced ?? config.jellyfinResolveOnOpen ?? false}
                  disabled={resolveForced !== null}
                  onCheckedChange={(next) => setConfig(prev => ({ ...prev, jellyfinResolveOnOpen: next ? true : undefined }))}
                  aria-label="Wait for the streams when a title opens"
                />
              </div>
            </div>

            <div className="space-y-3">
              <Label className="text-sm font-medium">Browsing</Label>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">Show a Latest row per catalog</Label>
                  <p className="text-[11px] text-muted-foreground">
                    On by default. A client asks each catalog for its newest titles to fill a row per catalog on the home screen, which is one catalog read each and slow to draw when many are enabled. There is no date a title entered a catalog here, so the row is its first page rather than what is new. Some clients build their whole home screen from these rows, so off leaves them empty.
                  </p>
                </div>
                <Switch
                  checked={config.jellyfinLatestRows !== false}
                  onCheckedChange={(next) => setConfig(prev => ({ ...prev, jellyfinLatestRows: next ? undefined : false }))}
                  aria-label="Show a Latest row per catalog"
                />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">Mark unaired episodes</Label>
                  <p className="text-[11px] text-muted-foreground">
                    On by default. Episodes that have not aired yet are sent as missing, so apps that support it show them as upcoming and do not offer to play them. Turn off to keep them playable, for when a stream addon has an episode early.
                  </p>
                </div>
                <Switch
                  checked={config.jellyfinMarkUnaired !== false}
                  onCheckedChange={(next) => setConfig(prev => ({ ...prev, jellyfinMarkUnaired: next ? undefined : false }))}
                  aria-label="Mark unaired episodes"
                />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">Upcoming row</Label>
                  <p className="text-[11px] text-muted-foreground">
                    {upcomingForced
                      ? 'Set by this server.'
                      : 'Caught up lists the next episode of the shows you have watched every aired episode of, so a show is in Upcoming or Next Up, never both. Everything airing lists the next episode of every show you follow, behind or not, so a show you are behind on can be in both. Watchlisted films that are not out yet are in it either way.'}
                  </p>
                </div>
                <Select
                  value={upcomingForced ?? config.jellyfinUpcomingMode ?? 'caught-up'}
                  disabled={upcomingForced !== null}
                  onValueChange={(v) => setConfig(prev => ({ ...prev, jellyfinUpcomingMode: v === 'airing' ? 'airing' : undefined }))}
                >
                  <SelectTrigger className="h-8 w-40 shrink-0 text-xs" aria-label="Upcoming row"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="caught-up">Caught up</SelectItem>
                    <SelectItem value="airing">Everything airing</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">Similar titles</Label>
                  <p className="text-[11px] text-muted-foreground">
                    The titles an app shows as similar on a title's page. TMDB suggests from its own recommendations. Simkl suggests what its users recommend alongside the title, or titles in the same genres when there are none, and uses TMDB for a title it does not know. Also what the More Like This catalog returns to apps that ask for one.
                  </p>
                </div>
                <Select
                  value={config.jellyfinSimilarSource ?? 'tmdb'}
                  onValueChange={(v) => setConfig(prev => ({ ...prev, jellyfinSimilarSource: v === 'simkl' ? 'simkl' : undefined }))}
                >
                  <SelectTrigger className="h-8 w-40 shrink-0 text-xs" aria-label="Similar titles"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tmdb">TMDB</SelectItem>
                    <SelectItem value="simkl">Simkl</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <div className="space-y-2 border-t pt-4">
            <Label className="text-sm font-medium">Users</Label>
            <p className="text-xs text-muted-foreground">
              Users appear on the client's sign-in screen. A user is made of the tags you pick for it: it sees the catalogs carrying any of them, under their rating limit. Someone else gets their own watch history and Continue Watching; a user that is you shares yours. Tags themselves are made in Catalogs.
            </p>
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
              }}
              allTags={tags}
              catalogCount={catalogCountFor(config.jellyfinUserTags ?? [])}
              trackerOptions={resumeSourceOptions}
              watchlistOptions={watchlistOptions}
              hasPmdb={Boolean(config.apiKeys?.publicmetadb)}
              mainSkipSource={config.jellyfinSkipSource ?? 'auto'}
              showHandoff={config.playbackReporting === true}
              watchedPoint={watchedPointFor('', mainName)}
              onForget={() => setForgetFor({ profile: null, name: mainName })}
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
                  showHandoff={config.playbackReporting === true}
                  watchedPoint={watchedPointFor(user.id, user.name)}
                  onChange={(patch) => updateUser(user.id, patch)}
                  onRemove={() => { void removeUser(user); }}
                  onForget={() => setForgetFor({ profile: user.id, name: user.name })}
                >
                  {user.trackers !== true ? (
                    <UserAccounts user={user} catalogs={config.catalogs ?? []} onChange={(next) => updateUser(user.id, next)} onAddCatalogs={addCatalogs} onRemoveCatalogs={removeCatalogs} />
                  ) : null}
                </UserRow>
              );
            })}
            {nameClash ? <p className="text-xs text-destructive">"{nameClash}" is used by two users. Each name, including AIOStreams names, must belong to one user.</p> : null}
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
              <Button size="sm" variant="outline" className="shrink-0 whitespace-nowrap" onClick={addUser} disabled={!newUserName.trim()}>
                <Plus className="mr-1 h-4 w-4" /> Add user
              </Button>
            </div>
          </div>
        </div>

        <div className="sticky bottom-0 -mx-4 -mb-4 mt-6 flex flex-col gap-2 border-t bg-card px-4 py-3 sm:-mx-6 sm:-mb-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className={cn('text-xs', isDirty ? 'text-amber-400' : 'text-muted-foreground')}>
            {isDirty
              ? 'Unsaved changes. Clients see users, passwords and settings only once saved.'
              : 'Everything here is saved.'}
          </p>
          <Button size="sm" disabled={!canSave || isSaving || !isDirty || Boolean(nameClash) || badPin} onClick={requestSave} className="w-full sm:w-auto">
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save configuration
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
