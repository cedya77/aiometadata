import { useMemo, useState } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { useSave } from "@/contexts/SaveContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Copy, Loader2, Plus, Save, User, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { TagChip } from "@/components/TagChip";
import { MAX_TAG_NAME_LENGTH, type JellyfinUser, type TagDef } from "@/contexts/config";

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

function Avatar({ src }: { src?: string }) {
  if (src && IMAGE_URL.test(src)) {
    return <img src={src} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover bg-muted" />;
  }
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <User className="h-5 w-5" />
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
  onChange: (patch: Partial<JellyfinUser>) => void;
  onRemove?: () => void;
}

function UserRow({ name, avatar, main, user, allTags, catalogCount, onChange, onRemove }: UserRowProps) {
  const chosen = user?.tags ?? [];
  const toggleTag = (tag: string) =>
    onChange({ tags: chosen.includes(tag) ? chosen.filter((t) => t !== tag) : [...chosen, tag] });
  const caps = allTags
    .filter((t) => chosen.includes(t.name) && t.ageRating && t.ageRating !== 'None')
    .map((t) => t.ageRating as string);

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-start gap-3">
        <Avatar src={avatar} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={name}
              maxLength={MAX_TAG_NAME_LENGTH}
              className="h-8 text-sm"
              aria-label={main ? 'Name of the main user' : `Name of ${name}`}
              onChange={(e) => onChange({ name: e.target.value })}
            />
            {onRemove ? (
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground" aria-label={`Remove ${name}`} onClick={onRemove}>
                <X className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
          <Input
            value={avatar ?? ''}
            placeholder="Picture address (https://...)"
            className="h-8 font-mono text-xs"
            aria-label={`Picture of ${name}`}
            onChange={(e) => onChange({ avatar: e.target.value || undefined })}
          />
        </div>
      </div>
      {main ? (
        <p className="text-xs text-muted-foreground">You. Every catalog, and your connected trackers.</p>
      ) : (
        <>
          {allTags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground mr-1">Tags:</span>
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
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {chosen.length === 0
                ? 'No tag picked: every catalog'
                : `${catalogCount} catalog${catalogCount === 1 ? '' : 's'}`}
            </span>
            {caps.length ? <span className="rounded-full border border-amber-500/40 px-1.5 text-[11px] text-amber-400">{caps.join(', ')} and lower</span> : null}
            <label className="ml-auto flex items-center gap-1.5" title="On: this is you on fewer catalogs, sharing your Continue Watching, watched marks and trackers. Off: someone else, with their own.">
              <Switch checked={user?.trackers === true} onCheckedChange={(next) => onChange({ trackers: next || undefined })} aria-label={`${name} is the same person as you`} />
              Same person as you
            </label>
          </div>
        </>
      )}
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
  const serverAddress = `${window.location.origin}/jellyfin/${userUUID}`;
  const mainName = config.jellyfinUserName || config.addonName || userUUID.slice(0, 8);
  const tags = useMemo(() => config.tags ?? [], [config.tags]);
  const users = useMemo(() => config.jellyfinUsers ?? [], [config.jellyfinUsers]);

  const catalogCountFor = (chosen: string[]) => {
    const wanted = new Set(chosen.map((t) => t.toLowerCase()));
    return (config.catalogs ?? []).filter((c) => c.enabled && (c.tags ?? []).some((t) => wanted.has(t.toLowerCase()))).length;
  };

  const [newUserName, setNewUserName] = useState('');
  const updateUser = (id: string, patch: Partial<JellyfinUser>) =>
    setConfig(prev => ({
      ...prev,
      jellyfinUsers: (prev.jellyfinUsers ?? []).map(u => (u.id === id ? { ...u, ...patch } : u)),
    }));
  const removeUser = (id: string) =>
    setConfig(prev => ({ ...prev, jellyfinUsers: (prev.jellyfinUsers ?? []).filter(u => u.id !== id) }));
  const addUser = () => {
    const clean = newUserName.trim();
    if (!clean) return;
    if (users.some(u => u.name.toLowerCase() === clean.toLowerCase()) || clean.toLowerCase() === mainName.toLowerCase()) {
      toast.error('There is already a user with that name');
      return;
    }
    setConfig(prev => ({ ...prev, jellyfinUsers: [...(prev.jellyfinUsers ?? []), { id: newUserId(), name: clean, tags: [] }] }));
    setNewUserName('');
  };

  const [quickConnectCode, setQuickConnectCode] = useState('');
  const [quickConnectProfile, setQuickConnectProfile] = useState('');
  const [approving, setApproving] = useState(false);


  // Only services that store a playback position can answer the Continue
  // Watching row, and only when they are connected and tracking is on.
  const resumeSourceOptions = useMemo(() => {
    const candidates: Array<{ value: string; label: string; ready: boolean }> = [
      { value: 'mdblist', label: 'MDBList', ready: Boolean(config.apiKeys?.mdblist) && config.mdblistWatchTracking !== false },
      { value: 'trakt', label: 'Trakt', ready: Boolean(config.apiKeys?.traktTokenId) && config.traktWatchTracking !== false },
      { value: 'simkl', label: 'Simkl', ready: Boolean(config.apiKeys?.simklTokenId) && config.simklWatchTracking !== false },
      { value: 'publicmetadb', label: 'PublicMetaDB', ready: Boolean(config.apiKeys?.publicmetadb) && config.publicmetadbWatchTracking !== false },
    ];
    return candidates.filter((c) => c.ready);
  }, [
    config.apiKeys?.mdblist,
    config.apiKeys?.traktTokenId,
    config.apiKeys?.simklTokenId,
    config.apiKeys?.publicmetadb,
    config.mdblistWatchTracking,
    config.traktWatchTracking,
    config.simklWatchTracking,
    config.publicmetadbWatchTracking,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
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

          <div className="space-y-2 border-t pt-3">
            <Label className="text-sm font-medium">Users</Label>
            <p className="text-xs text-muted-foreground">
              Users appear on the client's sign-in screen. A user is made of the tags you pick for it: it sees the catalogs carrying any of them, under their rating limit. Someone else gets their own watch history and Continue Watching; a user that is you shares yours. Tags themselves are made in Catalogs.
            </p>
            <UserRow
              main
              name={mainName}
              avatar={config.jellyfinUserAvatar}
              allTags={tags}
              catalogCount={0}
              onChange={(patch) => setConfig(prev => ({
                ...prev,
                ...('name' in patch ? { jellyfinUserName: patch.name } : {}),
                ...('avatar' in patch ? { jellyfinUserAvatar: patch.avatar } : {}),
              }))}
            />
            {users.map((user) => (
              <UserRow
                key={user.id}
                name={user.name}
                avatar={user.avatar}
                user={user}
                allTags={tags}
                catalogCount={catalogCountFor(user.tags)}
                onChange={(patch) => updateUser(user.id, patch)}
                onRemove={() => removeUser(user.id)}
              />
            ))}
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
              <Button size="sm" variant="outline" onClick={addUser} disabled={!newUserName.trim()}>
                <Plus className="mr-1 h-4 w-4" /> Add user
              </Button>
            </div>
          </div>

          <div className="space-y-1.5 border-t pt-3">
            <Label htmlFor="jellyfin-quick-connect" className="text-sm font-medium">Quick Connect</Label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {users.length > 0 ? (
                <Select value={quickConnectProfile || '__main__'} onValueChange={(v) => setQuickConnectProfile(v === '__main__' ? '' : v)}>
                  <SelectTrigger className="w-full sm:w-44" aria-label="Sign the device in as">
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

          <div className="space-y-1.5 border-t pt-3">
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

          <div className="space-y-1.5 border-t pt-3">
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
          </div>

          <div className="space-y-1.5 border-t pt-3">
            <Label htmlFor="jellyfin-resume-source" className="text-sm font-medium">Your trackers</Label>
            <Select
              value={config.jellyfinResumeSource ?? 'auto'}
              onValueChange={(value) => setConfig(prev => ({ ...prev, jellyfinResumeSource: value as NonNullable<typeof prev.jellyfinResumeSource> }))}
            >
              <SelectTrigger id="jellyfin-resume-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automatic</SelectItem>
                {resumeSourceOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
                <SelectItem value="off">This server only</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Anything played through this server is remembered here and shows in Continue Watching and as watched on its own. For you, and for users that are you, a connected tracker adds what was played elsewhere, such as on a phone. Only services that store a playback position can, so AniList and MyAnimeList are not offered. Automatic uses whichever connected service can.
            </p>
            {resumeSourceOptions.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No connected service stores playback positions, so only what is played through this server is shown. That is enough for a single client.
              </p>
            )}
          </div>

        </div>

        <div className="sticky bottom-0 -mx-4 -mb-4 mt-2 flex flex-col gap-2 border-t bg-card px-4 py-3 sm:-mx-6 sm:-mb-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className={cn('text-xs', isDirty ? 'text-amber-400' : 'text-muted-foreground')}>
            {isDirty
              ? 'Unsaved changes. Clients see users, passwords and settings only once saved.'
              : 'Everything here is saved.'}
          </p>
          <Button size="sm" disabled={!canSave || isSaving || !isDirty} onClick={requestSave} className="w-full sm:w-auto">
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save configuration
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
